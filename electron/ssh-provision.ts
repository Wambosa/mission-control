import { EXPECTED_SANDBOX_AGENT_VERSION } from "./sandbox-types";
import {
  defaultSshExec,
  shellQuote,
  sshShellArgs,
  sshStepFailure,
  type SshExec,
} from "./ssh-exec";
import {
  REMOTE_AGENT_COMMAND,
  REMOTE_AGENT_PACKAGE,
  type SshHostArch,
  type SshHostPlatform,
  type SshProvisionPlan,
} from "../src/shared/ssh-provision";
import {
  SSH_SERVICE_LABEL,
  SSH_SERVICE_UNIT_NAME,
  sshServiceUnitPath,
} from "../src/shared/ssh-service-unit";
import { describeRetainedHost } from "../src/shared/ssh-claims";
import {
  PREVIOUS_SSH_PREFIX_DIR_NAME,
  classifySshHostBrand,
  isRemovablePreviousPrefix,
  previousSshPrefixPath,
  type SshHostBrandVerdict,
} from "../src/shared/ssh-provision";
import {
  previousSshLayoutRemovalScript,
  previousSshServiceStopScript,
} from "../src/shared/ssh-service-unit";
import { unclaimSshHost } from "./ssh-claims";

// The install half of first connect. Everything Chaos Wrangler lays down goes
// under one directory the SSH user already owns, so provisioning needs no root,
// installs nothing globally, and touches no shell configuration — removing the
// host is `rm -rf` on that one directory and nothing else.
//
// The generated command strings are the artifact worth testing. A step is a
// self-contained POSIX script; running it is one SSH exec, and the sequence
// stops at the first one that fails.

/** Node's per-major channel. Answers "which build the runtime fetch pulls from". */
const NODE_CHANNEL = "https://nodejs.org/dist/latest-v24.x";

/**
 * Node publishes `.tar.xz` too, and it is much smaller — but extracting it
 * needs `xz` on the host, which a minimal Linux image often lacks. `.tar.gz`
 * costs bandwidth once and keeps the host requirement at "a shell and tar".
 */
const NODE_ARCHIVE_EXT = "tar.gz";

export type SshProvisionCommand = {
  /** Stable id, so a caller can say which step failed. */
  id: "prefix" | "runtime" | "agent";
  /** Shown by the provisioning UI while the step runs. */
  label: string;
  /** A POSIX script, run over one `sh -s`. */
  script: string;
};

export type SshProvisionProgress = {
  command: SshProvisionCommand;
  /** 0-based position in the sequence. */
  index: number;
  total: number;
  status: "running" | "done" | "failed";
};

export type SshProvisionRunResult =
  | { ok: true; prefix: string }
  | { ok: false; failedStep: SshProvisionCommand["id"]; error: string };

export type SshProvisionOptions = {
  /** The agent version this build of Chaos Wrangler speaks. */
  agentVersion?: string;
  onProgress?: (progress: SshProvisionProgress) => void;
  exec?: SshExec;
};

/** Directories inside the prefix, relative to it. */
export const SSH_PREFIX_BIN = "bin";
export const SSH_PREFIX_RUNTIME = "runtime";
export const SSH_PREFIX_SERVICE = "service";
const SSH_PREFIX_LOG = "log";
const SSH_PREFIX_TMP = "tmp";
const SSH_PREFIX_NPM_CACHE = "npm-cache";

/**
 * Shared by every step: fail loudly, keep the prefix on PATH so a runtime this
 * sequence installed is the one later steps use, and keep npm's cache inside
 * the prefix so removing the host leaves nothing behind.
 */
export function sshPrefixPrelude(prefix: string): string {
  const quoted = shellQuote(prefix);
  return [
    "set -eu",
    `MC_PREFIX=${quoted}`,
    `PATH="$MC_PREFIX/${SSH_PREFIX_BIN}:$MC_PREFIX/${SSH_PREFIX_RUNTIME}/${SSH_PREFIX_BIN}:$PATH"`,
    "export PATH",
    `npm_config_cache="$MC_PREFIX/${SSH_PREFIX_NPM_CACHE}"`,
    "npm_config_update_notifier=false",
    "export npm_config_cache npm_config_update_notifier",
  ].join("\n");
}

function createPrefixScript(prefix: string): string {
  const dirs = [SSH_PREFIX_BIN, SSH_PREFIX_SERVICE, SSH_PREFIX_LOG]
    .map((dir) => `"$MC_PREFIX/${dir}"`)
    .join(" ");
  return [
    sshPrefixPrelude(prefix),
    // 0700: the service env file under here holds the host's bearer secret.
    `mkdir -p ${dirs}`,
    `chmod 700 "$MC_PREFIX"`,
    "",
  ].join("\n");
}

/**
 * Fetch a Node build for the probed platform and architecture rather than
 * asking a package manager, which would want root and would install globally.
 * The channel's own `SHASUMS256.txt` names the current build and verifies the
 * download, so nothing here pins a version that would rot.
 */
function installRuntimeScript(prefix: string, platform: SshHostPlatform, arch: SshHostArch): string {
  // The probe already normalizes to the names Node uses in a release filename.
  const slug = `${platform}-${arch}`;
  return [
    sshPrefixPrelude(prefix),
    `mc_fetch() {`,
    `  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"`,
    `  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"`,
    `  else echo "this host has neither curl nor wget, so the runtime cannot be fetched" >&2; return 1`,
    `  fi`,
    `}`,
    `mc_tmp="$MC_PREFIX/${SSH_PREFIX_TMP}"`,
    `rm -rf "$mc_tmp"`,
    `mkdir -p "$mc_tmp"`,
    `mc_fetch ${shellQuote(`${NODE_CHANNEL}/SHASUMS256.txt`)} > "$mc_tmp/SHASUMS256.txt"`,
    // The channel index is the only place the current build number appears.
    `mc_file=$(sed -n 's/^[0-9a-f]\\{64\\}  \\(node-v24\\.[0-9.]*-${slug}\\.${NODE_ARCHIVE_EXT.replace(".", "\\.")}\\)$/\\1/p' "$mc_tmp/SHASUMS256.txt" | head -n 1)`,
    `if [ -z "$mc_file" ]; then echo "no Node build published for ${slug}" >&2; exit 1; fi`,
    `mc_fetch "${NODE_CHANNEL}/$mc_file" > "$mc_tmp/$mc_file"`,
    // A tarball piped straight into tar is a tarball nobody checked.
    `cd "$mc_tmp"`,
    `grep -F "  $mc_file" SHASUMS256.txt | head -n 1 > node.sha256`,
    `if command -v sha256sum >/dev/null 2>&1; then sha256sum -c node.sha256`,
    `elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -c node.sha256`,
    `else echo "this host has no sha256 tool, so the runtime download cannot be verified" >&2; exit 1`,
    `fi`,
    `rm -rf "$MC_PREFIX/${SSH_PREFIX_RUNTIME}"`,
    `mkdir -p "$MC_PREFIX/${SSH_PREFIX_RUNTIME}"`,
    `tar -xzf "$mc_tmp/$mc_file" -C "$MC_PREFIX/${SSH_PREFIX_RUNTIME}" --strip-components=1`,
    `rm -rf "$mc_tmp"`,
    `"$MC_PREFIX/${SSH_PREFIX_RUNTIME}/${SSH_PREFIX_BIN}/node" --version`,
    "",
  ].join("\n");
}

/**
 * npm's `--global` means "global to the prefix", and the prefix here is the one
 * directory Chaos Wrangler owns. Nothing lands outside it, and no other npm
 * install on the host is touched.
 */
function installAgentScript(prefix: string, agentVersion: string): string {
  return [
    sshPrefixPrelude(prefix),
    `npm install --global --prefix "$MC_PREFIX" --no-fund --no-audit ${shellQuote(`${REMOTE_AGENT_PACKAGE}@${agentVersion}`)}`,
    `if [ ! -x "$MC_PREFIX/${SSH_PREFIX_BIN}/${REMOTE_AGENT_COMMAND}" ]; then`,
    `  echo "${REMOTE_AGENT_COMMAND} is not in the prefix after install" >&2`,
    `  exit 1`,
    `fi`,
    // node-pty forks through a small helper binary its published tarball does
    // not mark executable. Without this the agent installs, starts, and then
    // fails on the first PTY — which is the only thing a session is.
    `find "$MC_PREFIX/lib/node_modules" -name spawn-helper -type f -exec chmod +x {} + 2>/dev/null || true`,
    // Opening one throwaway PTY is the difference between "the package is on
    // disk" and "this host can run a session". A Linux host with no compiler
    // for node-pty's native build fails here, by name, rather than at first use.
    `mc_agent_dir="$MC_PREFIX/lib/node_modules/${REMOTE_AGENT_PACKAGE}"`,
    `if ! mc_pty=$(node -e 'const d=process.argv[1];const pty=require(require.resolve("node-pty",{paths:[d]}));pty.spawn("/bin/echo",["ok"],{name:"xterm-color",cols:80,rows:24}).kill();' "$mc_agent_dir" 2>&1); then`,
    `  echo "the agent installed but cannot open a PTY on this host: $mc_pty" >&2`,
    `  exit 1`,
    `fi`,
    "",
  ].join("\n");
}

/**
 * The steps that lay down the prefix itself. Harness CLIs ride the same prefix
 * but install separately, so one that fails does not fail the connect.
 */
export function sshProvisionCommands(
  plan: SshProvisionPlan,
  options: { agentVersion?: string } = {},
): SshProvisionCommand[] {
  const agentVersion = options.agentVersion ?? EXPECTED_SANDBOX_AGENT_VERSION;
  const commands: SshProvisionCommand[] = [
    {
      id: "prefix",
      label: "Creating the Chaos Wrangler directory",
      script: createPrefixScript(plan.prefix),
    },
  ];

  if (plan.steps.some((step) => step.kind === "runtime")) {
    commands.push({
      id: "runtime",
      label: "Installing the Node runtime",
      script: installRuntimeScript(plan.prefix, plan.platform, plan.arch),
    });
  }
  if (plan.steps.some((step) => step.kind === "agent")) {
    commands.push({
      id: "agent",
      label: "Installing the Chaos Wrangler agent",
      script: installAgentScript(plan.prefix, agentVersion),
    });
  }
  return commands;
}

// ── Removal ────────────────────────────────────────────────────────────────

export type SshHostTarget = {
  platform: SshHostPlatform;
  /** The SSH user's home directory, as the host reported it. */
  homeDir: string;
  /** The prefix this host was provisioned into. */
  prefix: string;
};

export type SshRemovalResult = {
  /**
   * Always true: the local record must go even when the host does not answer,
   * or a machine that died takes its Chaos Wrangler entry hostage.
   */
  ok: true;
  /** What is still on the host, when anything is. */
  leftBehind?: { prefix: string; reason: string };
  /**
   * Set when the host was deliberately left intact because another client
   * still claims its runtime. Distinct from `leftBehind`, which reports a
   * teardown that was attempted and did not finish.
   */
  retained?: { reason: string };
};

/**
 * Undo provisioning, in the one order that works: unregister the service, then
 * delete what it pointed at. The reverse leaves the user's service manager
 * holding a unit whose binary is gone, retrying forever.
 *
 * Deliberately not `set -e`. Removal runs against half-provisioned hosts, hosts
 * whose service never registered, and hosts already partly cleaned by hand —
 * every step is best-effort, and stopping at the first "already gone" would
 * leave the rest behind.
 */
export function sshRemovalScript(target: SshHostTarget): string {
  const prefix = shellQuote(target.prefix);
  const unitPath = sshServiceUnitPath(target);
  const unregister =
    target.platform === "darwin"
      ? [
          `launchctl bootout gui/$(id -u)/${SSH_SERVICE_LABEL} >/dev/null 2>&1 || true`,
          `launchctl unload ${shellQuote(unitPath)} >/dev/null 2>&1 || true`,
        ]
      : [
          `systemctl --user stop ${SSH_SERVICE_UNIT_NAME} >/dev/null 2>&1 || true`,
          `systemctl --user disable ${SSH_SERVICE_UNIT_NAME} >/dev/null 2>&1 || true`,
        ];

  return [
    "set -u",
    ...unregister,
    `rm -f ${shellQuote(unitPath)} || true`,
    target.platform === "darwin"
      ? `true`
      : `systemctl --user daemon-reload >/dev/null 2>&1 || true`,
    // Only now, with nothing pointing at it.
    `rm -rf ${prefix} || true`,
    // The user's SSH config is theirs; the alias still works for ordinary ssh.
    "",
  ].join("\n");
}

/**
 * Clean a host and say what, if anything, survived. This never reports
 * failure: the caller's job is to drop the local record, and a host that
 * cannot be reached must not block that. What it could not remove is named
 * so the user can finish by hand.
 */
export async function removeSshHost(
  alias: string,
  target: SshHostTarget,
  options: { exec?: SshExec; clientId?: string } = {},
): Promise<SshRemovalResult> {
  const exec = options.exec ?? defaultSshExec;

  // Give up this client's claim before deciding anything. The runtime belongs
  // to the host, not to whoever is walking away from it — so a host another
  // Chaos Wrangler still uses keeps everything, and only the local record
  // goes. Without this the first client to remove a shared host deletes the
  // prefix out from under every other one.
  if (options.clientId) {
    const remaining = await unclaimSshHost(alias, target.prefix, options.clientId, exec);
    const retained = describeRetainedHost(remaining);
    if (retained) return { ok: true, retained: { reason: retained } };
  }

  const result = await exec(sshShellArgs(alias), sshRemovalScript(target));
  if (result.code === 0) return { ok: true };
  return {
    ok: true,
    leftBehind: {
      prefix: target.prefix,
      reason: sshStepFailure("Removing Chaos Wrangler from this host", result),
    },
  };
}

/**
 * Walk the sequence against a host, one SSH exec per step. A step that fails
 * stops the run and names itself, because a half-built prefix is worth
 * reporting rather than papering over.
 */
export async function runSshProvision(
  alias: string,
  plan: SshProvisionPlan,
  options: SshProvisionOptions = {},
): Promise<SshProvisionRunResult> {
  const exec = options.exec ?? defaultSshExec;
  const commands = sshProvisionCommands(plan, { agentVersion: options.agentVersion });
  const total = commands.length;

  for (const [index, command] of commands.entries()) {
    options.onProgress?.({ command, index, total, status: "running" });
    const result = await exec(sshShellArgs(alias), command.script);
    if (result.code !== 0) {
      options.onProgress?.({ command, index, total, status: "failed" });
      return { ok: false, failedStep: command.id, error: sshStepFailure(command.label, result) };
    }
    options.onProgress?.({ command, index, total, status: "done" });
  }

  return { ok: true, prefix: plan.prefix };
}

// ---------------------------------------------------------------------------
// Retiring a host provisioned under the previous brand
// ---------------------------------------------------------------------------

export type SshRetirementResult =
  /** The previous layout is gone, or was never there. Safe to install. */
  | { ok: true; removed: boolean }
  /** Another client still uses this host. Its previous layout stays. */
  | { ok: true; removed: false; retained: { reason: string } }
  /**
   * Nothing was removed. `agentUnrevoked` means the previous service could not
   * be confirmed stopped, so its agent may still be serving with a key this
   * app cannot take back.
   */
  | { ok: false; error: string; agentUnrevoked: boolean };

/**
 * Take the previous release's layout off a host, in the one order that is safe.
 *
 * Claims first, because with several installs pointed at one host this is the
 * expected path and not an edge case: a host another client still claims keeps
 * its previous directory, and this app reports it as running an agent it cannot
 * revoke rather than deleting a peer's runtime out from under them.
 *
 * Then the stop, and only then the removal. Removing the directory of a service
 * that is still running revokes nothing — the agent holds its key in memory —
 * so an unconfirmed stop stops the whole teardown.
 *
 * Re-provisioning after this is a full reinstall: the prefix held the fetched
 * runtime and every installed harness CLI, so the host sits without an agent
 * for as long as that download takes.
 */
export async function retirePreviousSshLayout(
  alias: string,
  target: { platform: SshHostPlatform; homeDir: string; previousPrefix: string },
  options: { exec?: SshExec; clientId?: string } = {},
): Promise<SshRetirementResult> {
  const exec = options.exec ?? defaultSshExec;

  if (!isRemovablePreviousPrefix(target.previousPrefix)) {
    return {
      ok: false,
      agentUnrevoked: false,
      error: `Refusing to remove ${target.previousPrefix || "an unnamed path"}: a teardown target must be an absolute path ending in ${PREVIOUS_SSH_PREFIX_DIR_NAME}.`,
    };
  }

  if (options.clientId) {
    const remaining = await unclaimSshHost(alias, target.previousPrefix, options.clientId, exec);
    const retained = describeRetainedHost(remaining);
    if (retained) return { ok: true, removed: false, retained: { reason: retained } };
  }

  const stopped = await exec(sshShellArgs(alias), previousSshServiceStopScript(target.platform));
  if (stopped.code !== 0) {
    return {
      ok: false,
      agentUnrevoked: true,
      error: sshStepFailure("Stopping the previous agent service", stopped),
    };
  }

  const removed = await exec(sshShellArgs(alias), previousSshLayoutRemovalScript(target));
  if (removed.code !== 0) {
    return {
      ok: false,
      agentUnrevoked: false,
      error: sshStepFailure("Removing the previous layout", removed),
    };
  }

  return { ok: true, removed: true };
}

/**
 * Ask the host whether the previous layout is actually there.
 *
 * The recorded prefix cannot answer this on its own. A local migration that
 * fell back restores a database snapshot predating any re-provisioning, so the
 * record can rewind; and with several installs pointed at one host, the second
 * and third arrive at a host the first has already migrated while their own
 * records still say otherwise. The host's filesystem is the only witness.
 */
export async function probePreviousSshPrefixPresent(
  alias: string,
  previousPrefix: string,
  exec: SshExec = defaultSshExec,
): Promise<boolean | null> {
  if (!isRemovablePreviousPrefix(previousPrefix)) return false;
  const result = await exec(
    sshShellArgs(alias),
    `if [ -d ${shellQuote(previousPrefix)} ]; then echo present; else echo absent; fi\n`,
  );
  if (result.code !== 0) return null;
  const answer = result.stdout.trim();
  if (answer.endsWith("present")) return true;
  if (answer.endsWith("absent")) return false;
  return null;
}

export type SshHostBrandCheck =
  | { ok: true; verdict: SshHostBrandVerdict }
  | { ok: false; error: string };

/**
 * The gate that runs before a service start and before a provisioning run.
 *
 * Both are separate handlers and only the start path was ever guarded, so a
 * host under the previous identifiers would have had a service started by a
 * label that no longer exists — failing inside the service manager on Linux
 * and succeeding while starting nothing on macOS.
 */
export async function checkSshHostBrand(
  alias: string,
  input: { homeDir: string; recordedPrefix: string | null },
  exec: SshExec = defaultSshExec,
): Promise<SshHostBrandCheck> {
  const previousPrefix = previousSshPrefixPath(input.homeDir);
  const present = await probePreviousSshPrefixPresent(alias, previousPrefix, exec);
  if (present === null) {
    return { ok: false, error: `Could not tell whether ${alias} still uses its previous layout.` };
  }
  return {
    ok: true,
    verdict: classifySshHostBrand({
      recordedPrefix: input.recordedPrefix,
      previousPrefixPresent: present,
      homeDir: input.homeDir,
    }),
  };
}

/**
 * What to tell the user when the reinstall failed after the previous layout was
 * already torn down.
 *
 * This state is only reachable because the teardown stops the previous service
 * before the new one is installed, and it is indistinguishable from a host that
 * was never provisioned unless it is reported. Saying "provisioning failed"
 * would leave the user believing their host still has a working agent.
 */
export function agentlessSshHostMessage(alias: string, error: string): string {
  return `${error} ${alias} has no running agent: its previous runtime was stopped and removed before the new one could be installed. Re-provision it to bring one back.`;
}

/** What to tell the user about a host that has to be re-provisioned first. */
export function staleSshHostMessage(alias: string, previousPrefix: string): string {
  return `${alias} was set up by the previous version of this app and still runs its agent from ${previousPrefix}. Re-provision the host to move it over — nothing is started against it until you do.`;
}
