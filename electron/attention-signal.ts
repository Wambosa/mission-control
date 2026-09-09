/**
 * A dock-level signal that survives the operator being away.
 *
 * Window attention rather than a platform notification, and not for style. The
 * notification class requires a code-signed app from the next Electron major
 * onward and emits a failure event otherwise, and this fork signs ad-hoc;
 * window attention goes through a different mechanism entirely, so it is clear
 * of that dependency. It also does exactly what is wanted: the dock keeps
 * asking until the app is activated, and the platform cancels it then.
 *
 * Two hazards, both of which the guard flag exists for.
 *
 * Raising while the app is already frontmost has no effect AND no clearing
 * event will ever fire, so the signal would read as raised forever while
 * nothing was actually flashing. The raise is skipped in that case and retried
 * on a later sweep — the hard *stage* is sticky for the episode, but the
 * *raise* keeps trying until it lands or output resumes, because a threshold
 * crossed while the operator happened to be at their desk must not lose its
 * signal permanently.
 *
 * Raising twice without cancelling overwrites the platform's stored request
 * handle and orphans the first, which can never then be cancelled. The flag is
 * load-bearing, not tidiness.
 */

export type AttentionRaiseResult =
  | { raised: true }
  | { raised: false; reason: "already-raised" | "app-active" | "unsupported-platform" };

export type AttentionSignalDeps = {
  platform: NodeJS.Platform;
  /** True when the app is frontmost, where a raise is a no-op with no clearing event. */
  isAppActive: () => boolean;
  /** Start the signal. Returns a cancellation handle where the platform gives one. */
  requestAttention: () => number | null;
  cancelAttention: (handle: number | null) => void;
};

export class AttentionSignal {
  private handle: number | null = null;
  private raised = false;

  constructor(private readonly deps: AttentionSignalDeps) {}

  isRaised(): boolean {
    return this.raised;
  }

  raise(): AttentionRaiseResult {
    if (this.deps.platform !== "darwin" && this.deps.platform !== "win32") {
      return { raised: false, reason: "unsupported-platform" };
    }
    if (this.raised) return { raised: false, reason: "already-raised" };
    // Skipped, not swallowed: the caller retries while the episode stands.
    if (this.deps.isAppActive()) return { raised: false, reason: "app-active" };

    this.handle = this.deps.requestAttention();
    this.raised = true;
    return { raised: true };
  }

  /**
   * Stand the signal down.
   *
   * On macOS the platform has already cancelled the request by the time app
   * activation reaches us, so the real job here is resetting local bookkeeping
   * so the next raise can happen at all. Calling it without a prior raise is a
   * no-op rather than an error, because activation fires far more often than
   * this signal is up.
   */
  clear(): void {
    if (!this.raised) return;
    this.raised = false;
    const handle = this.handle;
    this.handle = null;
    try {
      this.deps.cancelAttention(handle);
    } catch {
      /* the platform may have cancelled it already; local state is what matters */
    }
  }
}
