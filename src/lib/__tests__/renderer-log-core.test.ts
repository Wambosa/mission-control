import { describe, expect, it, vi } from "vitest";
import { createRendererEventLogger } from "../renderer-log-core";
import { eventPayload as rendererEventPayload } from "~/shared/log-event-shape";

function harness(over: { bridgeReady?: () => boolean } = {}) {
  const send = vi.fn();
  const logger = createRendererEventLogger({
    send,
    bridgeReady: over.bridgeReady ?? (() => true),
  });
  return { logger, send };
}

describe("rendererEventPayload", () => {
  it("names the event and carries its ids in one object", () => {
    expect(rendererEventPayload("project.opened", { projectId: "p1" })).toEqual({
      event: "project.opened",
      projectId: "p1",
    });
  });

  // The whole reason for using the library's transport rather than the console
  // hook: the payload stays an object instead of flattening to a string.
  it("stays an object rather than a formatted string", () => {
    expect(typeof rendererEventPayload("nav.route", { to: "/a" })).toBe("object");
  });

  it("carries an event with no fields", () => {
    expect(rendererEventPayload("nav.route")).toEqual({ event: "nav.route" });
  });

  it("does not let a field rename the event", () => {
    // The event name is what every filter keys on, so it wins over a field
    // that happens to share its name.
    expect(rendererEventPayload("nav.route", { event: "spoofed" }).event).toBe("nav.route");
  });

  it("puts the event name first, so a truncated line still says what happened", () => {
    expect(Object.keys(rendererEventPayload("nav.route", { to: "/a" }))[0]).toBe("event");
  });
});

describe("createRendererEventLogger", () => {
  it("forwards the event once the bridge exists", () => {
    const { logger, send } = harness();
    logger("nav.route", { to: "/settings" });
    expect(send).toHaveBeenCalledWith("nav.route", {
      event: "nav.route",
      to: "/settings",
    });
  });

  // The renderer also runs under `vite`, where there is no main process to
  // receive the message and the transport's own fallback is a console error per
  // call.
  it("no-ops rather than throwing when the Electron bridge is absent", () => {
    const { logger, send } = harness({ bridgeReady: () => false });
    expect(() => logger("nav.route", { to: "/settings" })).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("re-checks the bridge per call rather than capturing it once", () => {
    // The injected global arrives with the preload script, so an answer cached
    // at module-evaluation time would be a permanent false.
    let ready = false;
    const { logger, send } = harness({ bridgeReady: () => ready });
    logger("nav.route", { to: "/a" });
    ready = true;
    logger("nav.route", { to: "/b" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("nav.route", { event: "nav.route", to: "/b" });
  });

  it("does not throw when the transport itself fails", () => {
    const send = vi.fn(() => {
      throw new Error("ipc closed");
    });
    const logger = createRendererEventLogger({ send, bridgeReady: () => true });
    // This runs inside a router subscription; a throw would take navigation
    // down with it.
    expect(() => logger("nav.route", { to: "/settings" })).not.toThrow();
  });

  it("emits one call per event rather than batching or dropping", () => {
    const { logger, send } = harness();
    logger("nav.route", { to: "/a" });
    logger("nav.route", { to: "/b" });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
