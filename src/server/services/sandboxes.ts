import type { Sandbox } from "~/db/schema";
import { MAX_TCP_PORT } from "~/shared/tcp-port";
import { safeJsonParse } from "~/shared/safe-json";
import {
  DEFAULT_SSH_IDLE_WINDOW_MINUTES,
  normalizeRemoteAgentUrl,
  parseSandboxImageProvenance,
  parseSshHostConfig,
  type SandboxGitAuthMode,
  type SandboxPublicView,
  type SandboxRemoteConfig,
} from "~/shared/sandbox";
import type { SshHostPlatform } from "~/shared/ssh-provision";
import { SANDBOXES_ENABLED_KEY } from "~/db/migrate-multi-sandbox";
import { randomUUID } from "node:crypto";
import {
  deleteSandboxRow,
  findAllSandboxes,
  findSandboxById,
  insertSandbox,
  updateSandboxRow,
} from "../repositories/sandboxes.repo";
import { findProjectIdsBySandboxId, updateProjectRow } from "../repositories/projects.repo";
import { deleteTasksByScope } from "../repositories/tasks.repo";
import { deleteUserTerminalsByScope } from "../repositories/user-terminals.repo";
import { deleteHomeTerminalsByScope } from "../repositories/home-terminals.repo";
import { events } from "../events";
import { deleteAllProjectImagesFor } from "./project-images";
import { setBooleanSetting } from "./settings";

// CRUD + scope-selection for sandboxes (isolated execution environments). The
// container lifecycle is owned by the Electron main; this layer manages only
// the model. A project names its own host, so there is no application-wide
// scope for it to keep.

export type SandboxState = {
  sandboxes: SandboxPublicView[];
  enabled: boolean;
};

const CONFIG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sanitizeRecord(value: Record<string, string> | null | undefined): Record<string, string> | null {
  if (!value) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (CONFIG_KEY.test(key) && typeof raw === "string") out[key] = raw;
  }
  return Object.keys(out).length ? out : null;
}

function normalizePorts(value: number[] | null | undefined): number[] | null {
  if (!value) return null;
  const ports = [...new Set(value.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 1 && v <= MAX_TCP_PORT))];
  ports.sort((a, b) => a - b);
  return ports.length ? ports : null;
}

function parseRemoteConfig(raw: string | null | undefined): SandboxRemoteConfig | null {
  const parsed = safeJsonParse<SandboxRemoteConfig | null>(raw, null);
  if (!parsed || typeof parsed.agentUrl !== "string") return null;
  const allowPlaintextPublic = parsed.allowPlaintextPublic === true;
  // An SSH host has no agent URL to store: it is reached through a tunnel this
  // client opens, on a loopback port chosen at connect time. Empty is that
  // host's normal, correct value — and rejecting the whole config for it made
  // every ssh-host row unreadable here, so the alias lookup below could never
  // match one and re-adding a host silently created a duplicate every time.
  // A URL that is present must still survive normalization.
  if (!parsed.agentUrl.trim()) return { ...parsed, agentUrl: "" };
  const agentUrl = normalizeRemoteAgentUrl(parsed.agentUrl, { allowPlaintextPublic });
  return agentUrl ? { ...parsed, agentUrl, ...(allowPlaintextPublic ? { allowPlaintextPublic } : {}) } : null;
}

function toPublicSandbox(row: Sandbox): SandboxPublicView {
  const buildArgs = safeJsonParse(row.buildArgs, {});
  const remote = parseRemoteConfig(row.remoteConfig);
  const image = parseSandboxImageProvenance(remote);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    color: row.color,
    imageTag: row.imageTag,
    dockerfilePath: row.dockerfilePath,
    buildArgKeys: Object.keys(buildArgs).sort(),
    hasBuildArgs: Object.keys(buildArgs).length > 0,
    gitAuthMode: row.gitAuthMode,
    declaredPorts: safeJsonParse(row.declaredPorts, []),
    remoteAgentUrl: remote?.agentUrl ?? null,
    remoteProvider: typeof remote?.provider === "string" ? remote.provider : null,
    remoteProviderName: typeof remote?.providerName === "string" ? remote.providerName : null,
    remoteStatus: typeof remote?.status === "string" ? remote.status : null,
    remoteStatusMessage: typeof remote?.statusMessage === "string" ? remote.statusMessage : null,
    remotePublicAddress: typeof remote?.publicIp === "string" ? remote.publicIp : null,
    projectId: typeof remote?.projectId === "string" ? remote.projectId : null,
    remoteImageId: image.imageId,
    remoteGoldenImage: image.goldenImage,
    remoteImageManifestVersion: image.imageManifestVersion,
    remoteImageAgentVersion: image.imageAgentVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasPairingToken: !!row.pairingToken,
    hasApiKey: row.kind === "remote-vm" && !!row.pairingToken,
    hasPortMap: !!row.portMap,
  };
}

/** The renderer's one-shot read: sandboxes + whether the dropdown shows + the
 *  selected scope (self-heals a dangling scope whose sandbox was deleted). */
export function getSandboxState(): SandboxState {
  const list = findAllSandboxes();
  return { sandboxes: list.map(toPublicSandbox), enabled: true };
}

export type ConnectRemoteSandboxInput = {
  name: string;
  agentUrl: string;
  apiKey: string;
  agentCa?: string | null;
};

/**
 * Register an externally-provisioned remote sandbox (the user installed and
 * started the agent themselves) so the existing connect machinery can reach it.
 * Unlike managed rows, no `provider`/`providerId`/`status` are persisted —
 * provider-less rows are what mark a sandbox as manually connected, keeping
 * every managed-cloud affordance (pause/resume/reconcile/teardown) off.
 * Returns null when the agent URL does not survive normalization (plaintext
 * ws:// to a non-loopback host, credentials/query in the URL, unparseable).
 */
export function connectRemoteSandbox(
  input: ConnectRemoteSandboxInput,
): SandboxPublicView | null {
  const agentUrl = normalizeRemoteAgentUrl(input.agentUrl);
  if (!agentUrl) return null;
  const agentCa = input.agentCa?.trim() || null;
  const now = Date.now();

  // Idempotent by agent endpoint: re-connecting to the same URL (retry after a
  // failed connect, rotated key, fresh CA) updates the existing manual row
  // instead of piling up duplicates. Managed rows always carry a provider, so
  // they can never be captured by this match.
  const existing = findAllSandboxes().find((row) => {
    if (row.kind !== "remote-vm") return false;
    const remote = parseRemoteConfig(row.remoteConfig);
    return !!remote && !remote.provider && remote.agentUrl === agentUrl;
  });
  const id = existing?.id ?? randomUUID();
  const remoteConfig: SandboxRemoteConfig = {
    agentUrl,
    ...(agentCa ? { agentCa } : {}),
    createdAt: existing ? parseRemoteConfig(existing.remoteConfig)?.createdAt ?? now : now,
    updatedAt: now,
  };
  if (existing) {
    updateSandboxRow(id, {
      name: input.name.trim(),
      pairingToken: input.apiKey,
      remoteConfig: JSON.stringify(remoteConfig),
      updatedAt: now,
    });
  } else {
    insertSandbox({
      id,
      name: input.name.trim(),
      kind: "remote-vm",
      pairingToken: input.apiKey,
      remoteConfig: JSON.stringify(remoteConfig),
      createdAt: now,
      updatedAt: now,
    });
  }
  // Mirror the deploy CLI: registering a sandbox turns sandbox support on so
  // the new row is immediately selectable as a project's host.
  setBooleanSetting(SANDBOXES_ENABLED_KEY, true);
  const row = findSandboxById(id);
  // The row was just written; a miss is a server fault, not a bad request.
  if (!row) throw new Error("sandbox row missing after connect write");
  return toPublicSandbox(row);
}

export type RegisterSshHostInput = {
  /** Alias exactly as it appears in the user's SSH config. */
  alias: string;
  name: string;
  /** Directory Mission Control provisioned into on the host. */
  prefix: string;
  platform: SshHostPlatform;
  /** Bearer secret Mission Control generated for this host's runtime. */
  apiKey: string;
  /**
   * Port the host's runtime listens on. Optional so a host recorded before
   * ports were kept per-host still registers; the tunnel then falls back to
   * the client-global setting.
   */
  agentPort?: number;
  /** Directory on the host the runtime may work in; omit for the user's home. */
  workspaceRoot?: string | null;
};

/**
 * Record a provisioned SSH host as a scope. Idempotent by alias: setting up a
 * host twice — a retry, a re-provision after a failure — updates the one row
 * rather than piling up duplicates of a machine the user has only one of.
 *
 * The row carries no agent URL. An SSH host's URL is the forward, which does
 * not exist until it connects.
 */
export function registerSshHost(input: RegisterSshHostInput): SandboxPublicView {
  const alias = input.alias.trim();
  const now = Date.now();

  const existing = findAllSandboxes().find((row) => {
    if (row.kind !== "ssh-host") return false;
    return parseSshHostConfig(parseRemoteConfig(row.remoteConfig))?.alias === alias;
  });
  const id = existing?.id ?? randomUUID();
  const previous = existing ? parseRemoteConfig(existing.remoteConfig) : null;
  const previousHost = parseSshHostConfig(previous);

  const remoteConfig: SandboxRemoteConfig = {
    agentUrl: "",
    ssh: {
      alias,
      prefix: input.prefix,
      platform: input.platform,
      // What this host's runtime listens on, kept with the host rather than in
      // a client-global setting: an adopted runtime picked its own port, and
      // the tunnel has to follow it.
      agentPort: input.agentPort ?? previousHost?.agentPort ?? null,
      // A root the user chose survives re-provisioning, like their other
      // per-host choices above.
      workspaceRoot:
        input.workspaceRoot?.trim() || previousHost?.workspaceRoot || null,
      // Re-provisioning must not quietly reset choices the user made.
      onDisconnect: previousHost?.onDisconnect ?? "persist",
      idleWindowMinutes: previousHost?.idleWindowMinutes ?? DEFAULT_SSH_IDLE_WINDOW_MINUTES,
    },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };

  const fields = {
    name: input.name.trim() || alias,
    pairingToken: input.apiKey,
    remoteConfig: JSON.stringify(remoteConfig),
    updatedAt: now,
  };
  if (existing) updateSandboxRow(id, fields);
  else insertSandbox({ id, kind: "ssh-host", createdAt: now, ...fields });

  setBooleanSetting(SANDBOXES_ENABLED_KEY, true);
  const row = findSandboxById(id);
  if (!row) throw new Error("sandbox row missing after SSH host write");
  return toPublicSandbox(row);
}

export type UpdateSandboxPatch = Partial<{
  name: string;
  color: string | null;
  imageTag: string | null;
  dockerfilePath: string | null;
  gitAuthMode: SandboxGitAuthMode;
  buildArgs: Record<string, string> | null;
  declaredPorts: number[] | null;
}>;

export function revealSandboxApiKey(id: string): string | null {
  const row = findSandboxById(id);
  if (!row || row.kind !== "remote-vm" || !row.pairingToken) return null;
  return row.pairingToken;
}

export function updateSandbox(id: string, patch: UpdateSandboxPatch): SandboxPublicView | null {
  const current = findSandboxById(id);
  if (!current) return null;
  const rowPatch: Partial<Sandbox> = { updatedAt: Date.now() };
  if (patch.name !== undefined) rowPatch.name = patch.name;
  if (patch.color !== undefined) rowPatch.color = patch.color;
  if (patch.imageTag !== undefined) rowPatch.imageTag = patch.imageTag;
  if (patch.dockerfilePath !== undefined) rowPatch.dockerfilePath = patch.dockerfilePath;
  if (patch.gitAuthMode !== undefined) rowPatch.gitAuthMode = patch.gitAuthMode;
  if (patch.buildArgs !== undefined) {
    const clean = sanitizeRecord(patch.buildArgs);
    rowPatch.buildArgs = clean ? JSON.stringify(clean) : null;
  }
  if (patch.declaredPorts !== undefined) {
    const ports = normalizePorts(patch.declaredPorts);
    rowPatch.declaredPorts = ports ? JSON.stringify(ports) : null;
  }
  updateSandboxRow(id, rowPatch);
  const next = findSandboxById(id);
  return next ? toPublicSandbox(next) : null;
}

/**
 * Removes a sandbox. What that means to its projects depends on what the
 * sandbox is:
 *
 * - A managed remote VM *contains* the project — Mission Control created it in
 *   there — so tearing the VM down takes the project with it (the FK cascades).
 * - An SSH host merely *runs* a project the user already had on disk. Removing
 *   the host must not take their project with it, so the binding is cleared
 *   first: the project falls back to Local, stated plainly, with no dangling
 *   reference to a machine that is gone.
 *
 * Call `electron.sandbox.destroy` before this so container/volume teardown
 * still has the persisted config.
 */
export function deleteSandbox(id: string): boolean {
  const sandbox = findSandboxById(id);
  if (!sandbox) return false;

  if (sandbox.kind === "ssh-host") {
    for (const projectId of findProjectIdsBySandboxId(id)) {
      updateProjectRow(projectId, {
        sandboxId: null,
        remoteDirectory: null,
        updatedAt: Date.now(),
      });
      events.emit("project:updated", { id: projectId });
    }
    // The project survives, so its history survives with it. A session's
    // scope_id is the record of where it ran, not a pointer that has to
    // resolve — the session list stopped filtering by it, and there is no
    // foreign key to cascade. Deleting the rows here would keep the project
    // and silently destroy every session ever run on the host.
  } else {
    for (const projectId of findProjectIdsBySandboxId(id)) {
      deleteAllProjectImagesFor(projectId);
      events.emit("project:deleted", { id: projectId });
    }
    // A managed VM contained its projects, and they go with it, so their
    // sessions and terminals have nothing left to belong to.
    deleteTasksByScope(id);
    deleteUserTerminalsByScope(id);
  }
  // Home terminals belong to no project either way: they are shells opened on
  // the machine itself, and the machine is going.
  deleteHomeTerminalsByScope(id);

  return deleteSandboxRow(id) > 0;
}

export function setSandboxesEnabled(_enabled: boolean): void {
  // Compatibility for older clients: sandboxes have graduated from
  // experimental and can no longer be disabled.
  setBooleanSetting(SANDBOXES_ENABLED_KEY, true);
}
