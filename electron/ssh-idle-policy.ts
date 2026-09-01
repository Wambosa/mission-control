import type { SshHostPersistence } from "../src/shared/sandbox";

// When a host's runtime should stop. Two separate questions with two separate
// answers: an idle host with nothing running stops after a window, and a host
// the user set to tear down stops the moment the client disconnects.
//
// Both are pure decisions over inputs the caller already has, so the rule is
// testable without a host, a clock, or a connection.

export type SshRuntimeAction = "keep-running" | "stop";

export type SshRuntimeDecision = {
  action: SshRuntimeAction;
  reason:
    | "sessions-running"
    | "idle-stop-disabled"
    | "window-not-elapsed"
    | "idle-window-elapsed"
    | "persist-on-disconnect"
    | "teardown-on-disconnect";
};

export type SshIdleInput = {
  /**
   * Sessions on the host, running or waiting. Deliberately not "sessions
   * producing output": a session sitting at a prompt is the case R15 exists
   * to protect.
   */
  sessionCount: number;
  /** Minutes with no sessions before the runtime stops. 0 disables the stop. */
  idleWindowMinutes: number;
  /** Milliseconds since the host last had a session. */
  idleSinceMs: number;
};

/** Whether an idle host's runtime should stop right now. */
export function sshIdleDecision(input: SshIdleInput): SshRuntimeDecision {
  if (input.sessionCount > 0) return { action: "keep-running", reason: "sessions-running" };

  const window = input.idleWindowMinutes;
  // A window of zero is the user turning the idle stop off. A negative or
  // nonsense one is not a licence to stop a host early.
  if (!Number.isFinite(window) || window <= 0) {
    return { action: "keep-running", reason: "idle-stop-disabled" };
  }

  return input.idleSinceMs >= window * 60_000
    ? { action: "stop", reason: "idle-window-elapsed" }
    : { action: "keep-running", reason: "window-not-elapsed" };
}

/**
 * What a disconnect means for this host's runtime. Persistence is the default
 * — the runtime already ships as a restart-always service, so stopping it is
 * the deviation the user has to ask for.
 */
export function sshDisconnectAction(preference: SshHostPersistence): SshRuntimeDecision {
  return preference === "teardown"
    ? { action: "stop", reason: "teardown-on-disconnect" }
    : { action: "keep-running", reason: "persist-on-disconnect" };
}
