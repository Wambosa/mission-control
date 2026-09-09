import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("electron-log/main", () => ({ default: logMock }));

import {
  __resetPendingSpawnsForTests,
  awaitSpawnGate,
  cancelPendingSpawn,
  cancelPendingSpawnsUnderPath,
} from "../pty-manager";
import {
  __resetPreflightForTests,
  startFsPermissionPreflight,
} from "../fs-permission-preflight";
import type { FsPermissionOutcome } from "../../src/shared/fs-permission";

/** Start a sweep whose probes stay outstanding until the test releases them. */
function stalledSweep() {
  const releases: Array<(outcome: FsPermissionOutcome) => void> = [];
  startFsPermissionPreflight({
    platform: "darwin",
    deadlineMs: 60_000,
    recordOutcomes: () => {},
    probeLocation: () =>
      new Promise<FsPermissionOutcome>((resolve) => {
        releases.push(resolve);
      }),
  });
  // The sweep chains its probes, so only one is ever outstanding: releasing
  // one starts the next. Drain until the chain runs dry.
  return {
    releaseAll: async () => {
      for (let i = 0; i < 20 && (releases.length > 0 || i < 2); i += 1) {
        for (const release of releases.splice(0)) release("readable");
        await settle();
      }
    },
  };
}

function resolvedSweep() {
  startFsPermissionPreflight({
    platform: "darwin",
    recordOutcomes: () => {},
    probeLocation: async () => "readable",
  });
}

/** Let the chained probe loop advance as far as it can. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

afterEach(() => {
  __resetPendingSpawnsForTests();
  __resetPreflightForTests();
});

describe("the session-start gate", () => {
  it("holds a spawn requested before the sweep resolves, then lets it through", async () => {
    const sweep = stalledSweep();
    let allowed: boolean | null = null;
    void awaitSpawnGate("t-1", "/projects/a", () => false).then((ok) => {
      allowed = ok;
    });

    await settle();
    expect(allowed).toBeNull();

    await sweep.releaseAll();
    await settle();
    expect(allowed).toBe(true);
  });

  it("does not make a spawn wait once the sweep has resolved", async () => {
    resolvedSweep();
    await settle();

    let allowed: boolean | null = null;
    void awaitSpawnGate("t-1", "/projects/a", () => false).then((ok) => {
      allowed = ok;
    });
    await Promise.resolve();
    expect(allowed).toBe(true);
  });

  it("lets a whole launch batch through on the one gate", async () => {
    const sweep = stalledSweep();
    const spawns = ["t-1", "t-2", "t-3"].map((taskId) =>
      awaitSpawnGate(taskId, `/projects/${taskId}`, () => false),
    );

    await sweep.releaseAll();
    await expect(Promise.all(spawns)).resolves.toEqual([true, true, true]);
  });

  it("abandons a spawn whose pane closed while it waited", async () => {
    const sweep = stalledSweep();
    const spawn = awaitSpawnGate("t-1", "/projects/a", () => false);

    await settle();
    expect(cancelPendingSpawn("t-1")).toBe(true);

    await sweep.releaseAll();
    await expect(spawn).resolves.toBe(false);
  });

  it("abandons only the waiting spawns under a torn-down path", async () => {
    const sweep = stalledSweep();
    const root = path.resolve("/projects/closing");
    const inside = awaitSpawnGate("t-inside", path.join(root, "packages", "app"), () => false);
    const outside = awaitSpawnGate("t-outside", path.resolve("/projects/other"), () => false);

    await settle();
    cancelPendingSpawnsUnderPath(root);

    await sweep.releaseAll();
    await expect(inside).resolves.toBe(false);
    await expect(outside).resolves.toBe(true);
  });

  it("abandons a spawn whose app began quitting while it waited", async () => {
    // A spawn that resumes after the quit handler has torn every PTY down
    // creates one nothing is left to kill.
    const sweep = stalledSweep();
    let quitting = false;
    const spawn = awaitSpawnGate("t-1", "/projects/a", () => quitting);

    await settle();
    quitting = true;
    await sweep.releaseAll();

    await expect(spawn).resolves.toBe(false);
  });

  it("reports a cancelled spawn only while it is actually waiting", async () => {
    expect(cancelPendingSpawn("never-started")).toBe(false);
  });

  it("leaves the remote spawn path ungated", async () => {
    // R27, and a guard against a later reader adding the await "for symmetry".
    // Remote scaffolding happens on another machine and touches no local
    // protected path, so a local consent dialog must never hold it hostage.
    const source = await readFile(path.resolve(__dirname, "..", "sandbox-manager.ts"), "utf8");
    expect(source).not.toContain("awaitFsPermissionPreflight");
    expect(source).not.toContain("awaitSpawnGate");
  });
});

describe("two spawns parked for the same task", () => {
  it("cancels both, and neither can un-register the other", async () => {
    // Keyed by task id, the second registration replaced the first, and the
    // first's cleanup then deleted the second — leaving a parked spawn nothing
    // could cancel, which is the failure the mechanism exists to prevent.
    const sweep = stalledSweep();
    const first = awaitSpawnGate("t-1", "/projects/a", () => false);
    const second = awaitSpawnGate("t-1", "/projects/a", () => false);

    await settle();
    expect(cancelPendingSpawn("t-1")).toBe(true);

    await sweep.releaseAll();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });

  it("cancels both when their project is torn down", async () => {
    const sweep = stalledSweep();
    const root = path.resolve("/projects/closing");
    const first = awaitSpawnGate("t-1", root, () => false);
    const second = awaitSpawnGate("t-1", path.join(root, "pkg"), () => false);

    await settle();
    cancelPendingSpawnsUnderPath(root);

    await sweep.releaseAll();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });
});
