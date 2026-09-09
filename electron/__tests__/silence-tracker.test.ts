import { afterEach, describe, expect, it } from "vitest";
import {
  REMOTE_TAIL_LIMIT_BYTES,
  TailRing,
  __resetSilenceTrackerForTests,
  getTrackedPty,
  markPtyTransportDown,
  monotonicNow,
  readPtyTail,
  recordPtyOutput,
  trackPty,
  trackedPtyCount,
  untrackPty,
} from "../silence-tracker";

afterEach(() => __resetSilenceTrackerForTests());

function track(ptyId: string, overrides: Partial<Parameters<typeof trackPty>[1]> = {}) {
  trackPty(ptyId, {
    transport: "local",
    readTail: () => `tail of ${ptyId}`,
    at: 1_000,
    ...overrides,
  });
}

describe("silence tracker", () => {
  it("stamps a newly tracked PTY from its spawn, never from zero", () => {
    // A zero would read as decades of silence and alert on every new session.
    trackPty("p1", { transport: "local", readTail: () => "" });
    const entry = getTrackedPty("p1")!;
    expect(entry.lastOutputMonotonicMs).toBeGreaterThan(0);
    expect(entry.lastOutputMonotonicMs).toBeLessThanOrEqual(monotonicNow());
  });

  it("advances the stamp when output is recorded", () => {
    track("p1");
    recordPtyOutput("p1", 5_000);
    expect(getTrackedPty("p1")!.lastOutputMonotonicMs).toBe(5_000);
  });

  it("keeps stamps independent per PTY id", () => {
    track("p1");
    track("p2");
    recordPtyOutput("p1", 9_000);
    expect(getTrackedPty("p1")!.lastOutputMonotonicMs).toBe(9_000);
    expect(getTrackedPty("p2")!.lastOutputMonotonicMs).toBe(1_000);
  });

  it("ignores output for a PTY it is not tracking", () => {
    expect(() => recordPtyOutput("never-tracked", 1)).not.toThrow();
    expect(trackedPtyCount()).toBe(0);
  });

  it("advances a remote PTY's stamp from its own callback", () => {
    track("rpty-1", { transport: "remote", taskId: "t-9" });
    recordPtyOutput("rpty-1", 4_000);
    const entry = getTrackedPty("rpty-1")!;
    expect(entry.transport).toBe("remote");
    expect(entry.lastOutputMonotonicMs).toBe(4_000);
  });

  it("retains the task id captured at spawn, so an alert can name the session", () => {
    track("rpty-1", { transport: "remote", taskId: "task-42" });
    expect(getTrackedPty("rpty-1")!.taskId).toBe("task-42");
  });

  it("records the shell and sandbox-internal flags on the entry", () => {
    track("p-shell", { shell: true });
    track("p-upgrade", { transport: "remote", sandboxInternal: true });
    expect(getTrackedPty("p-shell")!.shell).toBe(true);
    expect(getTrackedPty("p-shell")!.sandboxInternal).toBe(false);
    expect(getTrackedPty("p-upgrade")!.sandboxInternal).toBe(true);
  });

  it("removes an entry on teardown", () => {
    track("p1");
    untrackPty("p1");
    expect(getTrackedPty("p1")).toBeUndefined();
    expect(trackedPtyCount()).toBe(0);
  });

  it("marks a PTY transport-down, and clears it when output resumes", () => {
    track("rpty-1", { transport: "remote" });
    markPtyTransportDown("rpty-1");
    expect(getTrackedPty("rpty-1")!.transportDown).toBe(true);

    recordPtyOutput("rpty-1", 2_000);
    expect(getTrackedPty("rpty-1")!.transportDown).toBe(false);
  });

  it("reads a tail through the same operation for both transports", () => {
    track("p-local", { transport: "local", readTail: () => "local bytes" });
    track("p-remote", { transport: "remote", readTail: () => "remote bytes" });
    expect(readPtyTail("p-local")).toBe("local bytes");
    expect(readPtyTail("p-remote")).toBe("remote bytes");
  });

  it("returns an empty tail rather than losing an alert when the ring throws", () => {
    track("p1", {
      readTail: () => {
        throw new Error("ring is gone");
      },
    });
    expect(readPtyTail("p1")).toBe("");
    expect(readPtyTail("not-tracked")).toBe("");
  });

  it("does not allocate an entry per chunk", () => {
    track("p1");
    for (let i = 0; i < 5_000; i += 1) recordPtyOutput("p1", i);
    expect(trackedPtyCount()).toBe(1);
    expect(getTrackedPty("p1")!.lastOutputMonotonicMs).toBe(4_999);
  });
});

describe("TailRing", () => {
  it("returns what it has when it holds less than its bound", () => {
    const ring = new TailRing(100);
    ring.push("hello ");
    ring.push("world");
    expect(ring.read()).toBe("hello world");
  });

  it("is empty before anything is pushed", () => {
    expect(new TailRing(100).read()).toBe("");
  });

  it("evicts the oldest chunks past its bound", () => {
    const ring = new TailRing(10);
    ring.push("aaaaa");
    ring.push("bbbbb");
    ring.push("ccccc");
    const out = ring.read();
    expect(out).toContain("ccccc");
    expect(out).not.toContain("aaaaa");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(10);
  });

  it("trims a single oversized chunk to the bound rather than pinning it", () => {
    // Left whole it would sit there for the PTY's lifetime and evict every
    // later chunk on arrival, so the tail would stop reflecting recent output
    // at exactly the point an alert needs it.
    const ring = new TailRing(4);
    ring.push("a much longer line than the bound");
    expect(ring.read()).toBe("ound");

    ring.push("xy");
    expect(ring.read()).toBe("xy");
  });

  it("defaults to the extractor's scan cap, so it never holds bytes that get thrown away", () => {
    const ring = new TailRing();
    ring.push("x".repeat(REMOTE_TAIL_LIMIT_BYTES * 2));
    expect(Buffer.byteLength(ring.read(), "utf8")).toBe(REMOTE_TAIL_LIMIT_BYTES);
    ring.push("y");
    expect(ring.read()).toBe("y");
  });
});
