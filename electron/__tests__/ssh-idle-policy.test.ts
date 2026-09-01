import { describe, expect, it } from "vitest";
import { sshDisconnectAction, sshIdleDecision, type SshIdleInput } from "../ssh-idle-policy";

const MINUTE = 60_000;

function input(overrides: Partial<SshIdleInput> = {}): SshIdleInput {
  return {
    sessionCount: 0,
    idleWindowMinutes: 30,
    idleSinceMs: 31 * MINUTE,
    ...overrides,
  };
}

describe("sshIdleDecision", () => {
  it("keeps the runtime up for a session sitting at a prompt (AE6)", () => {
    // Idleness is "no sessions", never "no output" — a session waiting for the
    // user is a session, and stopping its runtime would kill it.
    const decision = sshIdleDecision(input({ sessionCount: 1, idleSinceMs: 90 * MINUTE }));

    expect(decision).toEqual({ action: "keep-running", reason: "sessions-running" });
  });

  it("stops a host with nothing running past the window (AE7)", () => {
    expect(sshIdleDecision(input())).toEqual({ action: "stop", reason: "idle-window-elapsed" });
  });

  it("keeps the runtime up before the window elapses", () => {
    const decision = sshIdleDecision(input({ idleSinceMs: 29 * MINUTE }));

    expect(decision).toEqual({ action: "keep-running", reason: "window-not-elapsed" });
  });

  it("treats a zero window as the idle stop being off", () => {
    const decision = sshIdleDecision(input({ idleWindowMinutes: 0, idleSinceMs: 1_000 * MINUTE }));

    expect(decision).toEqual({ action: "keep-running", reason: "idle-stop-disabled" });
  });

  it("stops exactly at the window, not a tick after", () => {
    expect(sshIdleDecision(input({ idleSinceMs: 30 * MINUTE })).action).toBe("stop");
    expect(sshIdleDecision(input({ idleSinceMs: 30 * MINUTE - 1 })).action).toBe("keep-running");
  });

  it("never stops on a negative or nonsense window", () => {
    expect(sshIdleDecision(input({ idleWindowMinutes: -5 })).action).toBe("keep-running");
    expect(sshIdleDecision(input({ idleWindowMinutes: Number.NaN })).action).toBe("keep-running");
  });
});

describe("sshDisconnectAction", () => {
  it("stops the runtime for a host set to tear down, however fresh it is", () => {
    expect(sshDisconnectAction("teardown")).toEqual({ action: "stop", reason: "teardown-on-disconnect" });
  });

  it("leaves the runtime up for a host set to persist", () => {
    expect(sshDisconnectAction("persist")).toEqual({ action: "keep-running", reason: "persist-on-disconnect" });
  });
});
