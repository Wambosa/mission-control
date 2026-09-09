import { describe, expect, it, vi } from "vitest";
import { AttentionSignal, type AttentionSignalDeps } from "../attention-signal";

function signal(overrides: Partial<AttentionSignalDeps> = {}) {
  const requestAttention = vi.fn(() => 7);
  const cancelAttention = vi.fn();
  let active = false;
  const deps: AttentionSignalDeps = {
    platform: "darwin",
    isAppActive: () => active,
    requestAttention,
    cancelAttention,
    ...overrides,
  };
  return {
    it: new AttentionSignal(deps),
    requestAttention,
    cancelAttention,
    setActive: (value: boolean) => {
      active = value;
    },
  };
}

describe("AttentionSignal", () => {
  it("requests attention once while the app is inactive", () => {
    const s = signal();
    expect(s.it.raise()).toEqual({ raised: true });
    expect(s.requestAttention).toHaveBeenCalledTimes(1);
    expect(s.it.isRaised()).toBe(true);
  });

  it("requests attention once, not twice, when raised again without clearing", () => {
    // Raising twice overwrites the platform's stored handle and orphans the
    // first request, which can then never be cancelled.
    const s = signal();
    s.it.raise();
    expect(s.it.raise()).toEqual({ raised: false, reason: "already-raised" });
    expect(s.requestAttention).toHaveBeenCalledTimes(1);
  });

  it("cancels the request when cleared", () => {
    const s = signal();
    s.it.raise();
    s.it.clear();
    expect(s.cancelAttention).toHaveBeenCalledWith(7);
    expect(s.it.isRaised()).toBe(false);
  });

  it("is a no-op when cleared without a prior raise", () => {
    const s = signal();
    expect(() => s.it.clear()).not.toThrow();
    expect(s.cancelAttention).not.toHaveBeenCalled();
  });

  it("does not raise while the app is active, and leaves the guard clear", () => {
    // The platform ignores it and no clearing event would ever fire, so the
    // signal would be stuck on with nothing actually flashing.
    const s = signal();
    s.setActive(true);
    expect(s.it.raise()).toEqual({ raised: false, reason: "app-active" });
    expect(s.requestAttention).not.toHaveBeenCalled();
    expect(s.it.isRaised()).toBe(false);
  });

  it("lands a retried raise once the app goes inactive", () => {
    const s = signal();
    s.setActive(true);
    expect(s.it.raise().raised).toBe(false);
    s.setActive(false);
    expect(s.it.raise().raised).toBe(true);
    expect(s.requestAttention).toHaveBeenCalledTimes(1);
  });

  it("can be raised again after activation cleared it", () => {
    const s = signal();
    s.it.raise();
    s.it.clear(); // what app activation triggers
    expect(s.it.raise().raised).toBe(true);
    expect(s.requestAttention).toHaveBeenCalledTimes(2);
  });

  it("survives a platform that has already cancelled the request itself", () => {
    // On macOS the request is gone by the time activation reaches the listener;
    // the listener's job is local bookkeeping, not cancelling.
    const s = signal({
      cancelAttention: () => {
        throw new Error("no such request");
      },
    });
    s.it.raise();
    expect(() => s.it.clear()).not.toThrow();
    expect(s.it.isRaised()).toBe(false);
  });

  it("reports an unsupported platform rather than attempting to raise", () => {
    const s = signal({ platform: "linux" });
    expect(s.it.raise()).toEqual({ raised: false, reason: "unsupported-platform" });
    expect(s.requestAttention).not.toHaveBeenCalled();
  });
});
