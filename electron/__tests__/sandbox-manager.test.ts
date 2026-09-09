import { describe, expect, it, vi } from "vitest";
import {
  cloneCoordinationKey,
  EXPECTED_SANDBOX_AGENT_VERSION,
  gitAuthCloneFailureHint,
  isAgentCredsSetupUnsupportedError,
  isSafeSshCloneRemote,
  isSandboxAgentVersionCurrent,
  makeCloneCoordinator,
  forgetRemotePtyState,
  releaseRemotePtysForSandbox,
  __trackRemotePtyForTests,
  __remotePtyStateExistsForTests,
  __pushRemoteTailForTests,
  liveRemotePtyIds,
} from "../sandbox-manager";
import {
  __resetSilenceTrackerForTests,
  getTrackedPty,
  readPtyTail,
} from "../silence-tracker";

/** A promise plus its resolve/reject, so a test can hold a clone "in flight". */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("sandbox-manager clone compatibility helpers", () => {
  it("accepts safe SSH clone remotes", () => {
    expect(isSafeSshCloneRemote("git@github.com:webdevcody/webdevcody.com.git")).toBe(true);
    expect(isSafeSshCloneRemote("ssh://git@example.com/owner/repo.git")).toBe(true);
  });

  it("rejects option-shaped or credential-bearing SSH remotes", () => {
    expect(isSafeSshCloneRemote("-Fconfig@example.com:owner/repo.git")).toBe(false);
    expect(isSafeSshCloneRemote("git@example.com:-oProxyCommand=evil/repo.git")).toBe(false);
    expect(isSafeSshCloneRemote("ssh://git:secret@example.com/owner/repo.git")).toBe(false);
  });

  it("detects stale sandbox agent versions", () => {
    expect(isSandboxAgentVersionCurrent(EXPECTED_SANDBOX_AGENT_VERSION)).toBe(true);
    expect(isSandboxAgentVersionCurrent("0.2.0")).toBe(false);
  });

  it("adds mode-specific guidance for SSH publickey clone failures", () => {
    const err = new Error("git clone failed: git@github.com: Permission denied (publickey).");

    expect(gitAuthCloneFailureHint("none", err)).toContain("no Git authentication");
    expect(gitAuthCloneFailureHint("copy-host", err)).toContain("copy file keys");
    expect(gitAuthCloneFailureHint("generate", err)).toContain("Add the generated public key");
    expect(gitAuthCloneFailureHint("generate", new Error("network failed"))).toBeNull();
  });

  it("points an SSH host at its own credentials, not a Mission Control panel", () => {
    // The host is the user's own machine and already holds their keys. Telling
    // them to copy keys onto it, or to let Mission Control generate a second
    // one, is advice for a VM Mission Control built - not for this.
    const err = new Error("git clone failed: git@github.com: Permission denied (publickey).");

    const hint = gitAuthCloneFailureHint("none", err, "ssh-host");

    expect(hint).toContain("its own SSH credentials");
    expect(hint).not.toContain("no Git authentication");
    expect(hint).not.toContain("configure panel");
  });

  it("keeps the VM guidance for a VM", () => {
    const err = new Error("git clone failed: git@github.com: Permission denied (publickey).");

    expect(gitAuthCloneFailureHint("none", err, "remote-vm")).toContain("no Git authentication");
  });

  it("detects old agents that silently drop the credential setup RPC", () => {
    expect(isAgentCredsSetupUnsupportedError(new Error("agent rpc creds.setup timed out"))).toBe(true);
    expect(isAgentCredsSetupUnsupportedError(new Error("Sandbox agent did not write Claude Code credentials."))).toBe(
      false,
    );
  });
});

describe("clone coordination key", () => {
  it("is stable for the same (sandbox, slug)", () => {
    expect(cloneCoordinationKey("sb-1", "app")).toBe(cloneCoordinationKey("sb-1", "app"));
  });

  it("distinguishes sandboxes, slugs, and the Local (null) scope", () => {
    expect(cloneCoordinationKey("sb-1", "app")).not.toBe(cloneCoordinationKey("sb-2", "app"));
    expect(cloneCoordinationKey("sb-1", "app")).not.toBe(cloneCoordinationKey("sb-1", "api"));
    // null (Local) maps to "" and must not collide with a real id, nor let a
    // slug bleed across the separator (e.g. id "a" + slug "b" vs id "" + slug "ab").
    expect(cloneCoordinationKey(null, "app")).not.toBe(cloneCoordinationKey("app", ""));
    expect(cloneCoordinationKey("a", "b")).not.toBe(cloneCoordinationKey("", "ab"));
  });
});

describe("clone single-flight coordinator", () => {
  it("collapses concurrent clones of the same key onto one run", async () => {
    const coord = makeCloneCoordinator();
    const d = deferred<string>();
    const work = vi.fn(() => d.promise);
    const key = cloneCoordinationKey("sb-1", "app");

    const a = coord.run(key, work);
    const b = coord.run(key, work);

    // The second caller joined the first's in-flight clone — no second git.clone.
    expect(work).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(coord.inFlightCount).toBe(1);

    d.resolve("cloned");
    await expect(a).resolves.toBe("cloned");
    await expect(b).resolves.toBe("cloned");
    expect(coord.inFlightCount).toBe(0);
  });

  it("runs different keys independently", async () => {
    const coord = makeCloneCoordinator();
    const work = vi.fn(() => Promise.resolve("ok"));

    await Promise.all([
      coord.run(cloneCoordinationKey("sb-1", "app"), work),
      coord.run(cloneCoordinationKey("sb-2", "app"), work),
    ]);

    expect(work).toHaveBeenCalledTimes(2);
    expect(coord.inFlightCount).toBe(0);
  });

  it("allows a fresh clone once the prior settles (no permanent block)", async () => {
    const coord = makeCloneCoordinator();
    const work = vi.fn(() => Promise.resolve("ok"));
    const key = cloneCoordinationKey("sb-1", "app");

    await coord.run(key, work);
    await coord.run(key, work);

    expect(work).toHaveBeenCalledTimes(2);
    expect(coord.inFlightCount).toBe(0);
  });

  it("propagates rejection to every joined caller and frees the slot", async () => {
    const coord = makeCloneCoordinator();
    const d = deferred<string>();
    const work = vi.fn(() => d.promise);
    const key = cloneCoordinationKey("sb-1", "app");

    const a = coord.run(key, work);
    const b = coord.run(key, work);
    d.reject(new Error("destination path already exists and is not an empty directory"));

    await expect(a).rejects.toThrow("already exists");
    await expect(b).rejects.toThrow("already exists");
    expect(work).toHaveBeenCalledTimes(1);
    expect(coord.inFlightCount).toBe(0);
  });
});

describe("remote PTY state on a dropped transport", () => {
  it("clears ownership, timing and tail state, and marks the sessions unreachable", () => {
    // The close handler used to dispose the batcher and forget the client but
    // leave these maps populated, and no exit event ever arrives for a dropped
    // connection. Anything built on that state inherits sessions that no
    // longer have a transport — which read as silent, not unreachable.
    __resetSilenceTrackerForTests();
    __trackRemotePtyForTests("rpty-a", "sandbox-1", "task-a");
    __trackRemotePtyForTests("rpty-b", "sandbox-1", "task-b");
    __trackRemotePtyForTests("rpty-other", "sandbox-2", "task-c");

    releaseRemotePtysForSandbox("sandbox-1");

    // The routing and timing state -- the part that leaked, because no exit
    // event is coming -- is gone.
    expect(__remotePtyStateExistsForTests("rpty-a")).toBe(false);
    expect(__remotePtyStateExistsForTests("rpty-b")).toBe(false);

    // But the sessions are still visible to the sweep, marked unreachable
    // rather than silently vanished -- otherwise nothing could say why they
    // stopped alerting.
    expect(getTrackedPty("rpty-a")?.transportDown).toBe(true);
    expect(getTrackedPty("rpty-b")?.transportDown).toBe(true);
    expect(liveRemotePtyIds()).toEqual(
      expect.arrayContaining(["rpty-a", "rpty-b", "rpty-other"]),
    );

    // A sandbox that did not drop keeps everything.
    expect(__remotePtyStateExistsForTests("rpty-other")).toBe(true);
    expect(getTrackedPty("rpty-other")?.transportDown).toBe(false);
    expect(getTrackedPty("rpty-other")?.taskId).toBe("task-c");
    __resetSilenceTrackerForTests();
  });

  it("stops tracking a dropped PTY once it is explicitly torn down", () => {
    __resetSilenceTrackerForTests();
    __trackRemotePtyForTests("rpty-a", "sandbox-1", "task-a");
    releaseRemotePtysForSandbox("sandbox-1");
    expect(liveRemotePtyIds()).toContain("rpty-a");

    forgetRemotePtyState("rpty-a");
    expect(liveRemotePtyIds()).not.toContain("rpty-a");
    expect(getTrackedPty("rpty-a")).toBeUndefined();
    __resetSilenceTrackerForTests();
  });

  it("forgets one remote PTY's state on its own teardown", () => {
    __resetSilenceTrackerForTests();
    __trackRemotePtyForTests("rpty-a", "sandbox-1", "task-a");
    forgetRemotePtyState("rpty-a");

    expect(__remotePtyStateExistsForTests("rpty-a")).toBe(false);
    expect(getTrackedPty("rpty-a")).toBeUndefined();
    __resetSilenceTrackerForTests();
  });

  it("keeps a remote session's tail locally, so it survives an unreachable agent", () => {
    // Replay is an RPC that resolves empty on timeout, so it would produce
    // nothing exactly when the alert matters most.
    __resetSilenceTrackerForTests();
    __trackRemotePtyForTests("rpty-a", "sandbox-1", "task-a");
    __pushRemoteTailForTests("rpty-a", "waiting for /Users/me/Documents/vault");

    expect(readPtyTail("rpty-a")).toContain("Documents/vault");
    __resetSilenceTrackerForTests();
  });
});
