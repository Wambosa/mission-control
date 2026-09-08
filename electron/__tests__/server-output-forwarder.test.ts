import { describe, expect, it, vi } from "vitest";
import { createServerOutputForwarder } from "../server-output-forwarder";

function harness(over: { isQuitting?: () => boolean } = {}) {
  const write = vi.fn();
  const forward = createServerOutputForwarder({
    write,
    isQuitting: over.isQuitting ?? (() => false),
  });
  return { forward, write };
}

describe("createServerOutputForwarder", () => {
  it("routes server output to the log transport rather than the parent's streams", () => {
    const { forward, write } = harness();
    forward("info", "listening on 41337");
    expect(write).toHaveBeenCalledWith("info", "[server] listening on 41337");
  });

  it("keeps stderr at error level so it is separable from ordinary output", () => {
    const { forward, write } = harness();
    forward("error", "migration failed");
    expect(write).toHaveBeenCalledWith("error", "[server] migration failed");
  });

  it("prefixes every line so server output stays separable from main's own", () => {
    const { forward, write } = harness();
    forward("info", "[api] GET /healthz");
    expect(write.mock.calls[0][1]).toMatch(/^\[server] /);
  });

  it("drops output once the app is quitting", () => {
    // electron-log tears its transport down on quit, and this used to guard a
    // stdio fd that had already gone away.
    const { forward, write } = harness({ isQuitting: () => true });
    forward("info", "shutting down");
    expect(write).not.toHaveBeenCalled();
  });

  it("swallows a write that loses its race with shutdown", () => {
    // Server output is diagnostic: a lost line beats a throw out of a readline
    // handler taking the quit path down with it.
    const write = vi.fn(() => {
      throw new Error("transport closed");
    });
    const forward = createServerOutputForwarder({ write, isQuitting: () => false });
    expect(() => forward("error", "late line")).not.toThrow();
  });

  it("re-reads the quitting state per line rather than capturing it once", () => {
    let quitting = false;
    const { forward, write } = harness({ isQuitting: () => quitting });
    forward("info", "before");
    quitting = true;
    forward("info", "after");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("info", "[server] before");
  });

  it("forwards an empty line rather than dropping it", () => {
    // Blank lines carry structure in the server's bracketed-tag output.
    const { forward, write } = harness();
    forward("info", "");
    expect(write).toHaveBeenCalledWith("info", "[server] ");
  });
});
