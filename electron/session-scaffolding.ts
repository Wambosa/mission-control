import { installAgentHooks } from "./agent-hooks";
import { installAgentMemoryBrief } from "./agent-memory-brief";
import { installBlockedLocationNote } from "./blocked-location-note";
import { ensureDiagramSkillForAgent } from "./ensure-diagram-skill";
import { ensureRecallMcpForAgent, removeRecallMcpForAgent } from "./ensure-recall-mcp";
import { ensureRecallSkillForAgent, removeRecallSkillForAgent } from "./ensure-recall-skill";
import { createProbeDeps, probeDirectoryQueued } from "./fs-permission-probe";

import type { PtyHookEnv } from "./pty-hook-env";
import { fetchRecallEnabled as defaultFetchRecallEnabled } from "./recall-enabled";
import { ensureStatuslineTap } from "../src/shared/statusline-tap";
import type { TaskAgent } from "../src/shared/domain";
import type { FsPermissionOutcome, FsPermissionRecord } from "../src/shared/fs-permission";
import { nodeScaffoldingFs, type ScaffoldingFs } from "../src/shared/scaffolding-fs";

/**
 * Everything the app reads or writes inside a session's working directory
 * before its terminal exists, behind one gate.
 *
 * Why one module. Several scaffolding steps read files under the session cwd —
 * the repository's `.gitignore`, the MCP config, the managed-skill
 * self-identification read, the agent's auto-load file — plus a recursive
 * removal, which enumerates and is therefore gated too. If that cwd sits under
 * a macOS-protected location with an unanswered consent prompt, each of those
 * reads parks a thread in an inter-process wait: synchronously, the Electron
 * main thread; asynchronously, one of the libuv pool's four threads, held for
 * the life of the process because a consent prompt has no timeout and an abort
 * signal cannot cancel a syscall already in flight.
 *
 * So the fix is not "make the reads async" — that trades a visible freeze for an
 * invisible one, where promise-based filesystem work across the whole main
 * process silently stops completing while the app still looks healthy. The fix
 * is to probe the cwd exactly once and not issue the reads at all when it comes
 * back blocked. One gated call per spawn instead of several.
 *
 * The asynchronous conversion is the second layer, for the window between the
 * probe and the reads. A lint rule bans synchronous filesystem calls in this
 * module and the async helpers it drives, so the next one added there cannot
 * quietly reintroduce the freeze.
 *
 * Two steps are NOT covered by that rule and are still synchronous:
 * `installAgentHooks` and `ensureStatuslineTap`, which read and write a
 * settings file under the cwd through `src/shared/json-settings-file.ts`. They
 * are protected by the probe above and nothing else, so a grant revoked in the
 * window between the probe and the call can still block the main thread.
 * Converting them reaches into shared modules the server's tests also drive,
 * which is why it has not been done here — but do not read the rule as
 * covering them.
 */

export type SessionScaffoldingResult =
  | { ran: true }
  /** Nothing was issued; `reason` is what the cwd probe found. */
  | { ran: false; reason: FsPermissionOutcome };

export type SessionScaffoldingDeps = {
  fs: ScaffoldingFs;
  probeCwd: (cwd: string) => Promise<FsPermissionOutcome>;
  fetchRecallEnabled: (mcEnv: PtyHookEnv | null) => Promise<boolean | null>;
  installHooks: typeof installAgentHooks;
  ensureStatuslineTap: (cwd: string) => void;
  installMemoryBrief: typeof installAgentMemoryBrief;
  installPermissionNote: typeof installBlockedLocationNote;
};

export type SessionScaffoldingParams = {
  appPath: string;
  cwd: string;
  agent: TaskAgent | undefined;
  taskId: string;
  mcEnv: PtyHookEnv | null;
  petEnabled: boolean;
  /** Shell terminals get hooks only; the agent scaffolding does not apply. */
  isAgentSession: boolean;
  /** What the last check of each protected location found, for the agent note. */
  fsPermissionRecords: readonly FsPermissionRecord[];
  deps?: Partial<SessionScaffoldingDeps>;
};

/**
 * Whether a probe outcome means "do not touch this directory".
 *
 * Only positive evidence of a block, or no answer at all, stops the
 * scaffolding. `absent` and `never-probed` fall through to the helpers, which
 * are individually fail-soft and have always degraded by skipping their step.
 */
export function blocksScaffolding(outcome: FsPermissionOutcome): boolean {
  return outcome === "privacy-blocked" || outcome === "filesystem-blocked" || outcome === "pending";
}

function defaultProbeCwd(cwd: string): Promise<FsPermissionOutcome> {
  return probeDirectoryQueued(cwd, createProbeDeps().readdir);
}

export async function runSessionScaffolding(
  params: SessionScaffoldingParams,
): Promise<SessionScaffoldingResult> {
  const { appPath, cwd, agent, taskId, mcEnv, petEnabled, isAgentSession, fsPermissionRecords } =
    params;
  const fs = params.deps?.fs ?? nodeScaffoldingFs;
  const probeCwd = params.deps?.probeCwd ?? defaultProbeCwd;
  const fetchRecall = params.deps?.fetchRecallEnabled ?? defaultFetchRecallEnabled;
  const installHooks = params.deps?.installHooks ?? installAgentHooks;
  const statuslineTap = params.deps?.ensureStatuslineTap ?? ensureStatuslineTap;
  const memoryBrief = params.deps?.installMemoryBrief ?? installAgentMemoryBrief;
  const permissionNote = params.deps?.installPermissionNote ?? installBlockedLocationNote;

  const outcome = await probeCwd(cwd);
  if (blocksScaffolding(outcome)) return { ran: false, reason: outcome };

  installHooks(agent, cwd, undefined, { petEnabled });
  if (!isAgentSession) return { ran: true };

  await ensureDiagramSkillForAgent(appPath, cwd, agent, fs);

  // Recall provisioning follows the LIVE master switch so flipping the toggle
  // applies to the next session without an app restart. Off → actively remove
  // the managed skill + `.mcp.json` entry; on (or unknown — the fetch is
  // fail-soft) → install as before. A running session can't hot-swap its MCP
  // config, but the server also refuses Recall reads while disabled, so its
  // tools go dead regardless.
  const recallEnabled = await fetchRecall(mcEnv);
  if (recallEnabled === false) {
    await removeRecallSkillForAgent(cwd, agent, fs);
    await removeRecallMcpForAgent(cwd, agent, fs);
  } else {
    await ensureRecallSkillForAgent(appPath, cwd, agent, fs);
    // Recall code graph — file-based MCP config for local Claude sessions only
    // (self-gated inside). Never touches the spawn argv.
    await ensureRecallMcpForAgent(appPath, cwd, agent, fs);
  }

  // Claude sessions feed the shared usage-limits cache via the statusline tap,
  // so the top-bar indicator doesn't have to poll Anthropic's aggressively
  // rate-limited OAuth usage endpoint.
  if (agent === "claude-code") statuslineTap(cwd);

  // Recall — inject the project's Session Brief into the agent's auto-load file
  // BEFORE spawning so the agent reads current project memory on startup.
  await memoryBrief({ agent, cwd, taskId, mcEnv, fs });

  // A separate block in the same file. Order matters only in that the note is
  // written after the brief, so a failed brief fetch (which clears the brief's
  // block) cannot be mistaken for having cleared this one.
  await permissionNote({ agent, cwd, records: fsPermissionRecords, fs });

  return { ran: true };
}

/** The line the operator sees when their working directory could not be read. */
export function unreadableCwdNotice(cwd: string, reason: FsPermissionOutcome): string {
  const detail =
    reason === "privacy-blocked"
      ? "macOS is blocking access to it. Grant access in Settings → Diagnostics, then restart the session."
      : reason === "filesystem-blocked"
        ? "The filesystem denied access to it. Check the directory's permissions."
        : "No answer came back in time — a consent prompt may still be waiting.";
  return `Chaos Wrangler could not read this session's working directory.\r\n  ${cwd}\r\n  ${detail}\r\n  Session scaffolding was skipped; the agent may not behave as expected.\r\n\r\n`;
}
