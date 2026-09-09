import {
  silenceDecision,
  unavailableCredit,
  type SessionFacts,
  type SilenceStage,
} from "./silence-policy";
import { monotonicNow, type TrackedPty } from "./silence-tracker";
import type { FsPermissionCategory } from "../src/shared/fs-permission";

/**
 * One sweep over every session, on one interval.
 *
 * Not a timer per session, and the reason is not tidiness. A per-session
 * deadline lives in the same sleep-advancing clock, so a per-session design
 * *is* the wake storm, and correcting it would mean re-deriving the suspend
 * credit inside every timer. One sweep puts the correction in one place. It
 * also removes per-chunk timer churn from a path that can see hundreds of
 * chunks a second.
 *
 * The awake clock lives here and nowhere else: a monotonic reading minus an
 * accumulated total of time the app was not usefully running. The policy
 * function never sees a clock, which is what lets the thresholds be tested at
 * their exact boundaries.
 */

/** Fifteen seconds bounds detection lateness at five percent of the soft threshold. */
export const SWEEP_INTERVAL_MS = 15_000;
export const SOFT_THRESHOLD_MS = 5 * 60_000;
export const HARD_THRESHOLD_MS = 10 * 60_000;

/**
 * Slack on the sweep interval before a gap counts as anything at all.
 *
 * Ordinary event-loop scheduling under load routinely overshoots a 15 s timer
 * by a second or two, and crediting that would slowly erode real silence.
 */
const GAP_TOLERANCE_MS = 5_000;

/**
 * A gap so large it is credited without a resume event.
 *
 * The fallback for a suspend whose resume event never reached us. Set well
 * above anything a busy main thread produces, so an app-level stall stays
 * uncredited and real silence during it is still reported.
 */
const LARGE_GAP_MS = 5 * 60_000;

export type SilenceAlert = {
  ptyId: string;
  taskId: string | null;
  title: string;
  project: string | null;
  stage: Exclude<SilenceStage, "none">;
  /** Awake milliseconds of silence when the threshold was crossed. */
  silentMs: number;
  /** The operator typed more recently than the session spoke. */
  awaitingOperator: boolean;
};

/** One silent session, as the alert describes it to the renderer. */
export type SilenceAlertSession = {
  ptyId: string;
  taskId: string | null;
  title: string;
  project: string | null;
  /** Awake milliseconds of silence when the threshold was crossed. */
  silentMs: number;
  /** The operator typed more recently than the session spoke. */
  awaitingOperator: boolean;
  /** Stripped recent output. Absent when nothing legible survived. */
  tail?: string;
  /** A matched hang signature's fixed advice. */
  remediation?: string;
  /** Set when that advice is a privacy block the operator can act on directly. */
  privacyCategory?: FsPermissionCategory;
};

export type SilenceSweepDeps = {
  /** Live sessions, enumerated from the managers that own PTY lifecycle. */
  listSessions: () => readonly TrackedPty[];
  /** Session facts most recently pushed by the renderer, keyed by pty id. */
  facts: () => ReadonlyMap<string, SessionFacts>;
  onAlerts: (alerts: SilenceAlert[]) => void;
  /**
   * Called at the end of every sweep, whether or not anything alerted.
   *
   * A raise skipped because the app was frontmost has to be retried, and the
   * alert callback fires only on a threshold crossing — so the retry needs a
   * per-tick hook rather than an alert-shaped one.
   */
  onTick?: (state: { sessionsAtHardStage: string[] }) => void;
  now?: () => number;
  intervalMs?: number;
  softThresholdMs?: number;
  hardThresholdMs?: number;
};

type Episode = {
  stage: SilenceStage;
  /** The output stamp this episode was opened against. */
  lastSeenOutputAt: number;
  /** The credited-unavailable total at the moment that stamp was taken. */
  unavailableAtStamp: number;
};

export class SilenceSweep {
  private readonly deps: Required<Omit<SilenceSweepDeps, "onAlerts" | "onTick">> &
    Pick<SilenceSweepDeps, "onAlerts" | "onTick">;
  private readonly episodes = new Map<string, Episode>();
  private unavailableTotalMs = 0;
  private lastSweepAt: number | null = null;
  private resumeObserved = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SilenceSweepDeps) {
    this.deps = {
      now: monotonicNow,
      intervalMs: SWEEP_INTERVAL_MS,
      softThresholdMs: SOFT_THRESHOLD_MS,
      hardThresholdMs: HARD_THRESHOLD_MS,
      ...deps,
    };
  }

  start(): void {
    if (this.timer) return;
    this.lastSweepAt = this.deps.now();
    this.timer = setInterval(() => this.tick(), this.deps.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The machine woke up.
   *
   * This only classifies: it says the next gap was time the machine was away.
   * The gap itself supplies the magnitude — the event carries no duration, and
   * guessing one would be worse than measuring.
   */
  noteSystemResume(): void {
    this.resumeObserved = true;
    this.tick();
  }

  /** Sessions currently held at the hard stage, for the attention signal's retry. */
  sessionsAtHardStage(): string[] {
    return [...this.episodes]
      .filter(([, episode]) => episode.stage === "hard")
      .map(([ptyId]) => ptyId);
  }

  tick(): void {
    const now = this.deps.now();

    if (this.lastSweepAt !== null) {
      this.unavailableTotalMs += unavailableCredit({
        gapMs: now - this.lastSweepAt,
        expectedIntervalMs: this.deps.intervalMs,
        toleranceMs: GAP_TOLERANCE_MS,
        largeGapMs: LARGE_GAP_MS,
        resumeObserved: this.resumeObserved,
      });
    }
    this.lastSweepAt = now;
    this.resumeObserved = false;

    const sessions = this.deps.listSessions();
    const facts = this.deps.facts();
    const alerts: SilenceAlert[] = [];
    const live = new Set<string>();

    for (const session of sessions) {
      live.add(session.ptyId);
      let episode = this.episodes.get(session.ptyId);

      // Output resumed (or this is the first sighting): re-arm the episode and
      // anchor it to the credited total as it stands now, so the silence this
      // session accrues from here is measured against the same baseline.
      if (!episode || episode.lastSeenOutputAt !== session.lastOutputMonotonicMs) {
        episode = {
          stage: "none",
          lastSeenOutputAt: session.lastOutputMonotonicMs,
          unavailableAtStamp: this.unavailableTotalMs,
        };
        this.episodes.set(session.ptyId, episode);
      }

      const elapsed = now - session.lastOutputMonotonicMs;
      const credited = this.unavailableTotalMs - episode.unavailableAtStamp;
      const silentAwakeMs = Math.max(0, elapsed - credited);

      const decision = silenceDecision({
        silentAwakeMs,
        softThresholdMs: this.deps.softThresholdMs,
        hardThresholdMs: this.deps.hardThresholdMs,
        stage: episode.stage,
        shell: session.shell,
        sandboxInternal: session.sandboxInternal,
        transportDown: session.transportDown,
        facts: facts.get(session.ptyId) ?? null,
        inputAfterLastOutput:
          session.lastInputMonotonicMs > session.lastOutputMonotonicMs,
      });

      episode.stage = decision.stage;
      if (decision.action === "none") continue;

      const sessionFacts = facts.get(session.ptyId);
      alerts.push({
        ptyId: session.ptyId,
        taskId: session.taskId,
        title: sessionFacts?.title ?? "a session",
        project: sessionFacts?.project ?? null,
        stage: decision.action === "alert-hard" ? "hard" : "soft",
        silentMs: silentAwakeMs,
        awaitingOperator: decision.awaitingOperator,
      });
    }

    // A PTY that disappeared between sweeps takes its episode with it, so a
    // reused id can never inherit a stale stage.
    for (const ptyId of [...this.episodes.keys()]) {
      if (!live.has(ptyId)) this.episodes.delete(ptyId);
    }

    // Both callbacks reach out of this module -- to the renderer, to the dock,
    // to the settings store. A throw from any of them would escape the interval
    // as an uncaught main-process exception and end detection for the session.
    try {
      if (alerts.length > 0) this.deps.onAlerts(alerts);
    } catch {
      /* an alert that could not be delivered must not stop the next sweep */
    }
    try {
      this.deps.onTick?.({ sessionsAtHardStage: this.sessionsAtHardStage() });
    } catch {
      /* same */
    }
  }

  /** Test-only view of the credited unavailable total. */
  creditedUnavailableMs(): number {
    return this.unavailableTotalMs;
  }
}
