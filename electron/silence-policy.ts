import type { TaskStatus } from "../src/shared/domain";

/**
 * Whether a session has been quiet long enough to say so.
 *
 * A pure function over a plain input: no clock, no IO, no session lookup. The
 * awake clock is the sweep's problem, and keeping it out of here is what makes
 * the thresholds testable at their exact boundaries.
 *
 * What this decides is silence, not stuckness. Stuckness is not observable — a
 * session waiting ten minutes on a slow build and one wedged on a consent
 * prompt are byte-for-byte identical from outside. Silence is observable, and
 * a session silent for ten minutes is worth surfacing either way, which removes
 * the false-positive problem rather than solving it.
 */

export type SilenceStage = "none" | "soft" | "hard";
export type SilenceAction = "none" | "alert-soft" | "alert-hard";

export type SilenceReason =
  | "below-soft"
  | "soft-threshold-crossed"
  | "hard-threshold-crossed"
  | "already-alerted"
  | "shell-pane"
  | "sandbox-internal"
  | "transport-down"
  | "session-focused"
  | "status-awaiting-input"
  | "status-interrupted"
  | "status-terminal"
  | "status-disconnected"
  | "facts-unknown";

/**
 * What the renderer knows about a session and main does not.
 *
 * Pushed rather than fetched. Main holds no session semantics, and the focused
 * pane in particular has no other source — neither main nor the server knows
 * which terminal the operator is looking at, so no fetch could ever supply it.
 */
export type SessionFacts = {
  title: string;
  project: string | null;
  /**
   * The task's status, which the server owns and the renderer already has.
   *
   * A status is not terminal content: it comes from the agent's own hook
   * events, never from inspecting bytes. Detection still depends only on
   * output timing.
   */
  status: TaskStatus;
  /** This session is the visible pane of a focused window. */
  focused: boolean;
};

export type SilenceInput = {
  /** Milliseconds of awake time since this session last produced output. */
  silentAwakeMs: number;
  softThresholdMs: number;
  hardThresholdMs: number;
  /** The furthest threshold this silence episode has already alerted at. */
  stage: SilenceStage;
  shell: boolean;
  sandboxInternal: boolean;
  transportDown: boolean;
  /** Null until the renderer has reported this session. */
  facts: SessionFacts | null;
  /** The operator typed into this session more recently than it last spoke. */
  inputAfterLastOutput: boolean;
};

export type SilenceDecision = {
  action: SilenceAction;
  /** The stage after this decision. Sticky for the episode; the sweep resets it. */
  stage: SilenceStage;
  reason: SilenceReason;
  /**
   * The last thing that happened was the operator typing, not the agent
   * speaking — a session waiting on a person rather than on nothing. Both
   * stamps are timings, so this is still not content inspection.
   */
  awaitingOperator: boolean;
};

/**
 * Statuses that mean a session is legitimately quiet.
 *
 * `ready` and `running` are absent deliberately: those are the states a wedged
 * session sits in, and suppressing them would suppress the whole feature.
 */
const SUPPRESSING_STATUS: Partial<Record<TaskStatus, SilenceReason>> = {
  "needs-input": "status-awaiting-input",
  interrupted: "status-interrupted",
  finished: "status-terminal",
  terminated: "status-terminal",
  // The server's view of a session whose connection is gone. Unreachable, and
  // already reported as such; alerting on it as silence would double up.
  disconnected: "status-disconnected",
};

function suppressed(input: SilenceInput): SilenceReason | null {
  if (input.shell) return "shell-pane";
  if (input.sandboxInternal) return "sandbox-internal";
  if (input.transportDown) return "transport-down";
  // Fail closed, not fail soft. R23 forbids alerting a legitimately idle
  // session, and a decision made without status cannot tell one from a wedged
  // one — so a session whose facts have not arrived is held, not alerted. By
  // the authority hierarchy the requirement outranks the convenience.
  if (!input.facts) return "facts-unknown";
  if (input.facts.focused) return "session-focused";
  return SUPPRESSING_STATUS[input.facts.status] ?? null;
}

export function silenceDecision(input: SilenceInput): SilenceDecision {
  const awaitingOperator = input.inputAfterLastOutput;

  const reason = suppressed(input);
  if (reason) return { action: "none", stage: input.stage, reason, awaitingOperator };

  if (input.silentAwakeMs >= input.hardThresholdMs) {
    return input.stage === "hard"
      ? { action: "none", stage: "hard", reason: "already-alerted", awaitingOperator }
      : { action: "alert-hard", stage: "hard", reason: "hard-threshold-crossed", awaitingOperator };
  }

  if (input.silentAwakeMs >= input.softThresholdMs) {
    return input.stage === "none"
      ? { action: "alert-soft", stage: "soft", reason: "soft-threshold-crossed", awaitingOperator }
      : { action: "none", stage: input.stage, reason: "already-alerted", awaitingOperator };
  }

  return { action: "none", stage: input.stage, reason: "below-soft", awaitingOperator };
}

/**
 * How much of a sweep gap to treat as time the app was not running.
 *
 * A monotonic reading keeps advancing while macOS is suspended, so eight hours
 * asleep would cross both thresholds for every session at once. Choosing a
 * monotonic clock buys immunity to clock jumps and nothing else — this credit
 * carries the whole correction, and must not later be "simplified" away on the
 * belief that the clock covers it.
 *
 * The classifier and the magnitude are separate on purpose. A gap alone cannot
 * tell sleep from a stalled main thread, and the stall it will most often see
 * is this feature's own failure mode: a blocked read stalls the sweep for ten
 * minutes, the gap gets credited as sleep, and nothing alerts even though every
 * session genuinely went quiet. So a resume event classifies, the gap measures,
 * and a very large gap credits on its own as a fallback for a missed event.
 *
 * Crediting an app-level stall is still correct where it happens — the sessions
 * were frozen alongside the app — but it has to be a deliberate branch rather
 * than an accident of arithmetic.
 */
export function unavailableCredit(input: {
  gapMs: number;
  expectedIntervalMs: number;
  toleranceMs: number;
  largeGapMs: number;
  resumeObserved: boolean;
}): number {
  const excess = input.gapMs - input.expectedIntervalMs;
  if (excess <= input.toleranceMs) return 0;
  if (input.resumeObserved) return excess;
  return input.gapMs >= input.largeGapMs ? excess : 0;
}
