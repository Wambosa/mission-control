/**
 * When each PTY last produced output, and how to get at what it printed.
 *
 * One store for both transports, so the sweep has one place to read and neither
 * manager grows its own notion of silence. Deliberately passive: it holds
 * stamps and a way to fetch a tail, and it is never the authority on which
 * sessions exist. The sweep enumerates from the two managers that already own
 * PTY lifecycle, so a missed teardown here cannot turn a stale entry into a
 * phantom session.
 *
 * Timebase. The stamp is a monotonic reading, not a wall clock, and its name
 * says so — the existing per-PTY input stamp is wall clock, and subtracting one
 * from the other would produce a number that looks plausible and means nothing.
 * A monotonic reading is not by itself immune to sleep either: on macOS it keeps
 * advancing while the machine is suspended. Crediting that time away is the
 * sweep's job (see silence-policy.ts); all this file promises is a reading that
 * cannot jump when the system clock is set.
 */

export type SilenceTransport = "local" | "remote";

export type TrackedPty = {
  ptyId: string;
  transport: SilenceTransport;
  /** Retained so an alert can name the session. The remote path used to drop it. */
  taskId: string | null;
  /** A user-shell terminal, which is legitimately idle by nature. */
  shell: boolean;
  /** The sandbox agent's own upgrade PTY, which is not an operator's session. */
  sandboxInternal: boolean;
  /** The connection carrying this session is down: unreachable, not silent. */
  transportDown: boolean;
  /** Monotonic milliseconds. Never subtract a wall-clock stamp from this. */
  lastOutputMonotonicMs: number;
  /**
   * When the operator last typed into this session, on the SAME monotonic
   * clock as the output stamp.
   *
   * Both managers already keep a wall-clock input stamp for the battery-saver
   * pump. This is a second one rather than a reuse precisely so the two can be
   * compared: subtracting a wall-clock stamp from a monotonic one produces a
   * number that looks plausible and means nothing.
   */
  lastInputMonotonicMs: number;
};

export type TrackedPtyInit = {
  transport: SilenceTransport;
  taskId?: string | null;
  shell?: boolean;
  sandboxInternal?: boolean;
  /**
   * Implemented once per transport by whichever manager owns the bytes, so the
   * tail extractor takes a string and knows nothing about ring shapes.
   */
  readTail: () => string;
  /** Monotonic reading to stamp with; defaults to now. */
  at?: number;
};

export function monotonicNow(): number {
  return performance.now();
}

const tracked = new Map<string, TrackedPty & { readTail: () => string }>();

/** Test-only: drop every entry, following the repo's module-state reset pattern. */
export function __resetSilenceTrackerForTests(): void {
  tracked.clear();
}

/**
 * Start tracking a PTY, stamped from its spawn.
 *
 * Stamping at spawn rather than leaving the field at zero is load-bearing: a
 * zero would read as decades of silence and alert on every session the instant
 * it started. It also means a session that never emits anything is still
 * eventually reported, measured from when it began.
 */
export function trackPty(ptyId: string, init: TrackedPtyInit): void {
  tracked.set(ptyId, {
    ptyId,
    transport: init.transport,
    taskId: init.taskId ?? null,
    shell: init.shell ?? false,
    sandboxInternal: init.sandboxInternal ?? false,
    transportDown: false,
    lastOutputMonotonicMs: init.at ?? monotonicNow(),
    lastInputMonotonicMs: 0,
    readTail: init.readTail,
  });
}

/**
 * Advance a PTY's output stamp.
 *
 * Called from the raw chunk handler, not the batcher flush: the batcher
 * coalesces and delays — up to a second when the window is hidden, further
 * under power saving — so stamping at flush would inject phantom silence that
 * varies with window state. This does no allocation, because it runs on a path
 * that can see hundreds of chunks a second.
 */
export function recordPtyOutput(ptyId: string, at: number = monotonicNow()): void {
  const entry = tracked.get(ptyId);
  if (!entry) return;
  entry.lastOutputMonotonicMs = at;
  // Output arriving is proof the transport came back.
  if (entry.transportDown) entry.transportDown = false;
}

/** Note a renderer keystroke, on the output stamp's clock. */
export function recordPtyInput(ptyId: string, at: number = monotonicNow()): void {
  const entry = tracked.get(ptyId);
  if (entry) entry.lastInputMonotonicMs = at;
}

export function untrackPty(ptyId: string): void {
  tracked.delete(ptyId);
}

/** The connection is gone. Report unreachable, never silent. */
export function markPtyTransportDown(ptyId: string): void {
  const entry = tracked.get(ptyId);
  if (entry) entry.transportDown = true;
}

export function getTrackedPty(ptyId: string): TrackedPty | undefined {
  return tracked.get(ptyId);
}

export function trackedPtyCount(): number {
  return tracked.size;
}

/** The recent output of a PTY, through whichever ring its transport keeps. */
export function readPtyTail(ptyId: string): string {
  const entry = tracked.get(ptyId);
  if (!entry) return "";
  try {
    return entry.readTail();
  } catch {
    // A tail is a nicety on an alert; failing to read one must not lose the alert.
    return "";
  }
}

/**
 * How much recent remote output to keep locally.
 *
 * Matches the tail extractor's scan cap, so the ring never holds bytes the
 * extractor would throw away. The local path's ring is a megabyte because it
 * also serves replay; a tail has no such duty.
 */
export const REMOTE_TAIL_LIMIT_BYTES = 8_000;

/**
 * A small byte-bounded ring of recent output.
 *
 * Kept separate from the local PTY ring, and not because of the size. The local
 * ring carries sequence-tagged entries the replay protocol depends on for
 * ordering; a tail needs only bytes. Extracting one shared ring would drag
 * replay semantics onto the remote path or push the local path onto a lossier
 * abstraction.
 */
export class TailRing {
  private chunks: Array<{ data: string; bytes: number }> = [];
  private totalBytes = 0;

  constructor(private readonly limitBytes: number = REMOTE_TAIL_LIMIT_BYTES) {}

  push(data: string): void {
    if (!data) return;
    // A single write can be far larger than the whole ring — an agent dumping a
    // file, or `cat` on a build log. Keeping it whole would pin it for the
    // PTY's lifetime and leave the tail permanently stale, since every later
    // chunk would be evicted the moment it arrived. Only its end was ever
    // recent output anyway.
    const trimmed =
      Buffer.byteLength(data, "utf8") > this.limitBytes ? data.slice(-this.limitBytes) : data;
    const bytes = Buffer.byteLength(trimmed, "utf8");
    this.chunks.push({ data: trimmed, bytes });
    this.totalBytes += bytes;
    while (this.totalBytes > this.limitBytes && this.chunks.length > 1) {
      this.totalBytes -= this.chunks.shift()!.bytes;
    }
  }

  read(): string {
    return this.chunks.map((chunk) => chunk.data).join("");
  }
}
