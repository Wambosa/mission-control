import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetPreflightForTests,
  awaitFsPermissionPreflight,
  fsPermissionPreflightRecords,
  isFsPermissionPreflightResolved,
  startFsPermissionPreflight,
  type PreflightDeps,
} from "../fs-permission-preflight";
import { DECLARED_LOCATIONS, type FsPermissionOutcome } from "../../src/shared/fs-permission";

function deps(overrides: Partial<PreflightDeps> = {}): Partial<PreflightDeps> {
  return {
    platform: "darwin",
    probeLocation: async () => "readable",
    recordOutcomes: () => {},
    now: () => 1_000,
    deadlineMs: 10_000,
    ...overrides,
  };
}

afterEach(() => {
  __resetPreflightForTests();
  vi.useRealTimers();
});

describe("fs-permission pre-flight sweep", () => {
  it("resolves its gate once every declared location has an outcome", async () => {
    startFsPermissionPreflight(deps());
    await awaitFsPermissionPreflight();

    expect(isFsPermissionPreflightResolved()).toBe(true);
    const records = fsPermissionPreflightRecords();
    expect(records).toHaveLength(DECLARED_LOCATIONS.length);
    expect(records.every((record) => record.outcome === "readable")).toBe(true);
  });

  it("records each outcome with the time it was taken", async () => {
    const recordOutcomes = vi.fn();
    startFsPermissionPreflight(deps({ recordOutcomes, now: () => 4_242 }));
    await awaitFsPermissionPreflight();

    expect(recordOutcomes).toHaveBeenCalled();
    const [outcomes, checkedAt] = recordOutcomes.mock.calls.at(-1)!;
    expect(checkedAt).toBe(4_242);
    expect(outcomes).toHaveLength(DECLARED_LOCATIONS.length);
  });

  it("keeps probing the rest when one probe throws, and still resolves", async () => {
    let call = 0;
    startFsPermissionPreflight(
      deps({
        probeLocation: async () => {
          call += 1;
          if (call === 1) throw new Error("probe exploded");
          return "readable";
        },
      }),
    );
    await awaitFsPermissionPreflight();

    const records = fsPermissionPreflightRecords();
    expect(records[0].outcome).toBe("never-probed");
    expect(records.slice(1).every((r) => r.outcome === "readable")).toBe(true);
  });

  it("resolves when every probe fails", async () => {
    startFsPermissionPreflight(
      deps({
        probeLocation: async () => {
          throw new Error("nope");
        },
      }),
    );
    await expect(awaitFsPermissionPreflight()).resolves.toBeUndefined();
    expect(isFsPermissionPreflightResolved()).toBe(true);
  });

  it("resolves immediately off macOS and probes nothing", async () => {
    const probeLocation = vi.fn(async () => "readable" as FsPermissionOutcome);
    startFsPermissionPreflight(deps({ platform: "win32", probeLocation }));
    await awaitFsPermissionPreflight();

    expect(probeLocation).not.toHaveBeenCalled();
    expect(isFsPermissionPreflightResolved()).toBe(true);
  });

  it("runs one probe at a time, chained on completion", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    startFsPermissionPreflight(
      deps({
        probeLocation: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return "readable";
        },
      }),
    );
    await awaitFsPermissionPreflight();
    expect(maxInFlight).toBe(1);
  });

  it("starts exactly once even when the window is recreated", async () => {
    const probeLocation = vi.fn(async () => "readable" as FsPermissionOutcome);
    startFsPermissionPreflight(deps({ probeLocation }));
    startFsPermissionPreflight(deps({ probeLocation }));
    await awaitFsPermissionPreflight();

    expect(probeLocation).toHaveBeenCalledTimes(DECLARED_LOCATIONS.length);
  });

  it("resolves at its deadline with unanswered categories marked pending", async () => {
    vi.useFakeTimers();
    // A consent prompt has no timeout, so a probe that never settles is the
    // normal unhappy case, not an error. Never resolving is the hazard.
    startFsPermissionPreflight(deps({ probeLocation: () => new Promise<never>(() => {}) }));

    const gate = awaitFsPermissionPreflight();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(gate).resolves.toBeUndefined();

    expect(fsPermissionPreflightRecords().every((r) => r.outcome === "pending")).toBe(true);
  });

  it("upgrades a pending outcome when the stalled probe finally answers", async () => {
    vi.useFakeTimers();
    let release: ((outcome: FsPermissionOutcome) => void) | null = null;
    startFsPermissionPreflight(
      deps({
        probeLocation: () =>
          new Promise<FsPermissionOutcome>((resolve) => {
            release = resolve;
          }),
      }),
    );

    const gate = awaitFsPermissionPreflight();
    await vi.advanceTimersByTimeAsync(10_000);
    await gate;
    expect(fsPermissionPreflightRecords()[0].outcome).toBe("pending");

    release!("privacy-blocked");
    await vi.advanceTimersByTimeAsync(0);
    expect(fsPermissionPreflightRecords()[0].outcome).toBe("privacy-blocked");
  });

  it("publishes progress as each location settles, before the gate resolves", async () => {
    const seen: FsPermissionOutcome[][] = [];
    startFsPermissionPreflight(
      deps({ onUpdate: (records) => seen.push(records.map((r) => r.outcome)) }),
    );
    await awaitFsPermissionPreflight();

    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0].filter((o) => o === "readable")).toHaveLength(1);
    expect(seen.at(-1)!.every((o) => o === "readable")).toBe(true);
  });

  it("reports every declared location as never-probed before the sweep starts", () => {
    const records = fsPermissionPreflightRecords();
    expect(records).toHaveLength(DECLARED_LOCATIONS.length);
    expect(records.every((r) => r.outcome === "never-probed")).toBe(true);
    expect(isFsPermissionPreflightResolved()).toBe(false);
  });

  it("lets a batch of waiters through on the one gate", async () => {
    startFsPermissionPreflight(deps());
    const waiters = [
      awaitFsPermissionPreflight(),
      awaitFsPermissionPreflight(),
      awaitFsPermissionPreflight(),
    ];
    await expect(Promise.all(waiters)).resolves.toEqual([undefined, undefined, undefined]);
  });

  it("does not wait at all once the sweep has resolved", async () => {
    startFsPermissionPreflight(deps());
    await awaitFsPermissionPreflight();

    let resolvedSynchronously = false;
    void awaitFsPermissionPreflight().then(() => {
      resolvedSynchronously = true;
    });
    await Promise.resolve();
    expect(resolvedSynchronously).toBe(true);
  });
});
