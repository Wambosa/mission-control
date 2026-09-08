import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// pty-manager now logs PTY lifecycle, so without this the suite appends to the
// operator's real main.log — polluting the diagnostic artifact these events
// exist to produce. The mock carries every level the module uses, not only the
// ones it used when this file was written.
// vi.hoisted because vi.mock is lifted above the imports and cannot close over
// an ordinary top-level binding.
const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("electron-log/main", () => ({ default: logMock }));

import { disposeAllPtys, disposePty, isCwdWithin } from "../pty-manager";

beforeEach(() => {
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
  logMock.debug.mockClear();
});

/** The log payloads recorded for one event name. */
function eventsNamed(name: string): Record<string, unknown>[] {
  return logMock.info.mock.calls
    .filter(([event]) => event === name)
    .map(([, payload]) => payload as Record<string, unknown>);
}

describe("isCwdWithin", () => {
  const root = path.resolve(os.tmpdir(), "proj", ".worktree", "lunar-lunar-autumn");

  it("matches the worktree root itself", () => {
    expect(isCwdWithin(root, root)).toBe(true);
  });

  it("matches a nested cwd inside the worktree", () => {
    expect(isCwdWithin(path.join(root, "packages", "app"), root)).toBe(true);
  });

  it("rejects siblings and the parent project root", () => {
    const sibling = path.resolve(os.tmpdir(), "proj", ".worktree", "amber-forest-mountain");
    expect(isCwdWithin(sibling, root)).toBe(false);
    expect(isCwdWithin(path.resolve(os.tmpdir(), "proj"), root)).toBe(false);
  });

  it("does not match a path that only shares a name prefix", () => {
    expect(isCwdWithin(`${root}-2`, root)).toBe(false);
  });

  it("ignores drive-letter / segment casing on Windows", () => {
    if (os.platform() !== "win32") return;
    expect(isCwdWithin(root.toUpperCase(), root.toLowerCase())).toBe(true);
  });

  it("returns false for empty inputs", () => {
    expect(isCwdWithin("", root)).toBe(false);
    expect(isCwdWithin(root, "")).toBe(false);
  });
});

describe("disposePty", () => {
  // Regression guard for the PTY master leak: node-pty's kill() only SIGHUPs the
  // child and leaves the master /dev/ptmx fd open if the child survives the
  // signal. Teardown MUST close the master via destroy(), or a long-lived window
  // exhausts macOS's kern.tty.ptmx_max and every pty spawn on the machine fails.
  it("closes the master fd via destroy() instead of only signalling with kill()", () => {
    const destroy = vi.fn();
    const kill = vi.fn();
    disposePty({ pid: 4242, destroy, kill } as never);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to kill() only when destroy() is unavailable", () => {
    const kill = vi.fn();
    disposePty({ pid: 4242, kill } as never);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a missing proc and swallows teardown errors", () => {
    expect(() => disposePty(null)).not.toThrow();
    expect(() =>
      disposePty({
        pid: 1,
        destroy: () => {
          throw new Error("already gone");
        },
      } as never),
    ).not.toThrow();
  });

  // node-pty can abort() the whole process from inside its ThreadSafeFunction
  // callback during teardown — a C++ throw no JS catch can reach. A
  // dispose.begin with no matching end is the only surviving signature of that
  // crash, and the pid is what ties it to the rest of the log.
  it("brackets the teardown with a begin and end pair carrying the same pid", () => {
    disposePty({ pid: 4242, destroy: vi.fn() } as never);
    expect(eventsNamed("pty.dispose.begin")).toEqual([
      { event: "pty.dispose.begin", pid: 4242 },
    ]);
    expect(eventsNamed("pty.dispose.end")).toEqual([{ event: "pty.dispose.end", pid: 4242 }]);
  });

  it("still emits the end line when teardown throws, so the pair is not a false crash", () => {
    disposePty({
      pid: 77,
      destroy: () => {
        throw new Error("already gone");
      },
    } as never);
    expect(eventsNamed("pty.dispose.end")).toEqual([{ event: "pty.dispose.end", pid: 77 }]);
  });

  it("logs the begin line before teardown runs, so an abort leaves it behind", () => {
    // Ordering is the whole mechanism: a begin written after destroy() would be
    // lost to exactly the abort it is meant to record.
    let beginSeenBeforeDestroy = false;
    disposePty({
      pid: 9,
      destroy: () => {
        beginSeenBeforeDestroy = eventsNamed("pty.dispose.begin").length === 1;
      },
    } as never);
    expect(beginSeenBeforeDestroy).toBe(true);
  });

  it("emits nothing when silenced, so a bulk sweep can bracket itself instead", () => {
    disposePty({ pid: 1, destroy: vi.fn() } as never, { silent: true });
    expect(eventsNamed("pty.dispose.begin")).toEqual([]);
    expect(eventsNamed("pty.dispose.end")).toEqual([]);
  });

  it("emits nothing for a missing proc", () => {
    disposePty(null);
    expect(logMock.info).not.toHaveBeenCalled();
  });
});

describe("disposeAllPtys", () => {
  function fakePty(pid: number) {
    return { pid, destroy: vi.fn() } as never;
  }

  it("brackets the whole sweep with one pair carrying the live count", () => {
    disposeAllPtys([fakePty(1), fakePty(2), fakePty(3)]);
    expect(eventsNamed("pty.killAll.begin")).toEqual([
      { event: "pty.killAll.begin", live: 3 },
    ]);
    expect(eventsNamed("pty.killAll.end")).toEqual([{ event: "pty.killAll.end", live: 3 }]);
  });

  // The reason the per-PTY pairs are suppressed: each log call is a synchronous
  // open-write-close, so an unbatched loop over every live PTY becomes a burst
  // of file writes in one event-loop turn, on the most crash-prone path there
  // is.
  it("does not additionally emit a dispose pair per PTY inside the loop", () => {
    disposeAllPtys([fakePty(1), fakePty(2), fakePty(3)]);
    expect(eventsNamed("pty.dispose.begin")).toEqual([]);
    expect(eventsNamed("pty.dispose.end")).toEqual([]);
  });

  it("writes a fixed number of lines regardless of how many PTYs are live", () => {
    disposeAllPtys([fakePty(1)]);
    const forOne = logMock.info.mock.calls.length;
    logMock.info.mockClear();
    disposeAllPtys(Array.from({ length: 25 }, (_, i) => fakePty(i)));
    expect(logMock.info.mock.calls.length).toBe(forOne);
  });

  it("still tears every PTY down", () => {
    const procs = [fakePty(1), fakePty(2)];
    disposeAllPtys(procs);
    for (const proc of procs) {
      expect((proc as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalledTimes(1);
    }
  });

  it("reports a zero count rather than staying silent on an empty sweep", () => {
    // Silence would be ambiguous with a sweep that never ran.
    disposeAllPtys([]);
    expect(eventsNamed("pty.killAll.begin")).toEqual([
      { event: "pty.killAll.begin", live: 0 },
    ]);
  });

  it("keeps going past a PTY whose teardown throws", () => {
    const survivor = fakePty(2);
    disposeAllPtys([
      {
        pid: 1,
        destroy: () => {
          throw new Error("already gone");
        },
      } as never,
      survivor,
    ]);
    expect((survivor as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalled();
    expect(eventsNamed("pty.killAll.end")).toEqual([{ event: "pty.killAll.end", live: 2 }]);
  });
});
