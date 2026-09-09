import { describe, expect, it, vi } from "vitest";
import {
  HARD_THRESHOLD_MS,
  SOFT_THRESHOLD_MS,
  SWEEP_INTERVAL_MS,
  SilenceSweep,
  type SilenceAlert,
} from "../silence-sweep";
import type { SessionFacts } from "../silence-policy";
import type { TrackedPty } from "../silence-tracker";

/**
 * The sleep case is the one most likely to be wrong and the least likely to be
 * exercised by hand, so it is driven with a clock whose jumps model a suspend
 * rather than by sleeping a machine.
 */
function harness() {
  let clock = 1_000_000;
  const sessions = new Map<string, TrackedPty>();
  const facts = new Map<string, SessionFacts>();
  const alerts: SilenceAlert[] = [];

  const sweep = new SilenceSweep({
    now: () => clock,
    listSessions: () => [...sessions.values()],
    facts: () => facts,
    onAlerts: (batch) => alerts.push(...batch),
  });

  const addSession = (ptyId: string, overrides: Partial<TrackedPty> = {}) => {
    sessions.set(ptyId, {
      ptyId,
      transport: "local",
      taskId: `task-${ptyId}`,
      shell: false,
      sandboxInternal: false,
      transportDown: false,
      lastOutputMonotonicMs: clock,
      lastInputMonotonicMs: 0,
      ...overrides,
    });
    facts.set(ptyId, { title: `session ${ptyId}`, project: "proj", status: "running", focused: false });
  };

  return {
    sweep,
    alerts,
    sessions,
    facts,
    addSession,
    /** Advance the clock and run the sweeps that would have fired. */
    advance(ms: number, { sweeps = true } = {}) {
      const steps = sweeps ? Math.floor(ms / SWEEP_INTERVAL_MS) : 0;
      for (let i = 0; i < steps; i += 1) {
        clock += SWEEP_INTERVAL_MS;
        sweep.tick();
      }
      const remainder = ms - steps * SWEEP_INTERVAL_MS;
      if (remainder > 0) clock += remainder;
    },
    /** Jump the clock with no sweeps in between — a suspend, or a stall. */
    jump(ms: number) {
      clock += ms;
    },
    emitOutput(ptyId: string) {
      const session = sessions.get(ptyId)!;
      session.lastOutputMonotonicMs = clock;
    },
    tick: () => sweep.tick(),
    now: () => clock,
  };
}

describe("threshold crossing over the sweep", () => {
  it("alerts once at soft when a session goes quiet", () => {
    const h = harness();
    h.addSession("p1");
    h.advance(SOFT_THRESHOLD_MS + SWEEP_INTERVAL_MS);

    const soft = h.alerts.filter((a) => a.stage === "soft");
    expect(soft).toHaveLength(1);
    expect(soft[0].title).toBe("session p1");
    expect(soft[0].taskId).toBe("task-p1");
    expect(soft[0].silentMs).toBeGreaterThanOrEqual(SOFT_THRESHOLD_MS);
  });

  it("escalates to hard once, and does not repeat either alert", () => {
    const h = harness();
    h.addSession("p1");
    h.advance(HARD_THRESHOLD_MS * 2);

    expect(h.alerts.filter((a) => a.stage === "soft")).toHaveLength(1);
    expect(h.alerts.filter((a) => a.stage === "hard")).toHaveLength(1);
  });

  it("raises nothing for a session that keeps producing output", () => {
    const h = harness();
    h.addSession("p1");
    for (let i = 0; i < 60; i += 1) {
      h.advance(SWEEP_INTERVAL_MS);
      h.emitOutput("p1");
    }
    expect(h.alerts).toEqual([]);
  });

  it("re-arms the episode when output resumes, and alerts again on the next silence", () => {
    const h = harness();
    h.addSession("p1");
    h.advance(SOFT_THRESHOLD_MS + SWEEP_INTERVAL_MS);
    expect(h.alerts).toHaveLength(1);

    h.emitOutput("p1");
    h.advance(SWEEP_INTERVAL_MS);
    h.advance(SOFT_THRESHOLD_MS + SWEEP_INTERVAL_MS);

    const soft = h.alerts.filter((a) => a.stage === "soft");
    expect(soft).toHaveLength(2);
  });

  it("measures a session that never produces output from its spawn", () => {
    const h = harness();
    h.addSession("p1");
    h.advance(SOFT_THRESHOLD_MS + SWEEP_INTERVAL_MS);
    expect(h.alerts).toHaveLength(1);
  });
});

describe("the awake clock", () => {
  it("credits a long gap following a resume, so sleep alone crosses nothing", () => {
    const h = harness();
    h.addSession("p1");
    h.advance(SWEEP_INTERVAL_MS * 4);

    h.jump(8 * 60 * 60_000);
    h.sweep.noteSystemResume();

    expect(h.alerts).toEqual([]);
    expect(h.sweep.creditedUnavailableMs()).toBeGreaterThan(7 * 60 * 60_000);
  });

  it("leaves silence accrued before a sleep intact across it", () => {
    // Four minutes quiet at lid-close is still four minutes quiet on wake:
    // re-stamping every session on resume would have discarded it.
    const h = harness();
    h.addSession("p1");
    h.advance(4 * 60_000);
    h.jump(8 * 60 * 60_000);
    h.sweep.noteSystemResume();
    expect(h.alerts).toEqual([]);

    // One more awake minute is enough to reach the soft threshold; nothing more.
    h.advance(60_000 + SWEEP_INTERVAL_MS * 2);
    expect(h.alerts.filter((a) => a.stage === "soft")).toHaveLength(1);
    expect(h.alerts.filter((a) => a.stage === "hard")).toHaveLength(0);
  });

  it("credits nothing for an ordinary overshoot of the interval", () => {
    const h = harness();
    h.addSession("p1");
    h.advance(SWEEP_INTERVAL_MS);
    h.jump(SWEEP_INTERVAL_MS + 2_000);
    h.tick();
    expect(h.sweep.creditedUnavailableMs()).toBe(0);
  });

  it("credits nothing for a stall below the large-gap fallback with no resume", () => {
    // The app's own freeze looks exactly like this. Crediting it would mask
    // the real silence every session accrued while the app was wedged.
    const h = harness();
    h.addSession("p1");
    h.advance(SWEEP_INTERVAL_MS);
    h.jump(90_000);
    h.tick();
    expect(h.sweep.creditedUnavailableMs()).toBe(0);
  });

  it("credits a very large gap even when the resume event was missed", () => {
    const h = harness();
    h.addSession("p1");
    h.advance(SWEEP_INTERVAL_MS);
    h.jump(4 * 60 * 60_000);
    h.tick();
    expect(h.sweep.creditedUnavailableMs()).toBeGreaterThan(3 * 60 * 60_000);
    expect(h.alerts).toEqual([]);
  });
});

describe("suppression through the sweep", () => {
  it("never alerts a shell pane or a sandbox-internal PTY", () => {
    const h = harness();
    h.addSession("p-shell", { shell: true });
    h.addSession("p-internal", { sandboxInternal: true });
    h.advance(HARD_THRESHOLD_MS * 2);
    expect(h.alerts).toEqual([]);
  });

  it("never alerts a session whose transport dropped", () => {
    const h = harness();
    h.addSession("p1", { transportDown: true });
    h.advance(HARD_THRESHOLD_MS * 2);
    expect(h.alerts).toEqual([]);
  });

  it("holds a session whose facts have not been pushed", () => {
    const h = harness();
    h.addSession("p1");
    h.facts.delete("p1");
    h.advance(HARD_THRESHOLD_MS * 2);
    expect(h.alerts).toEqual([]);
  });

  it("decides normally on the next sweep once the facts arrive", () => {
    const h = harness();
    h.addSession("p1");
    h.facts.delete("p1");
    h.advance(SOFT_THRESHOLD_MS + SWEEP_INTERVAL_MS);
    expect(h.alerts).toEqual([]);

    h.facts.set("p1", { title: "late arrival", project: null, status: "running", focused: false });
    h.advance(SWEEP_INTERVAL_MS);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0].title).toBe("late arrival");
  });

  it("discards a stale facts entry for a session that no longer exists", () => {
    const h = harness();
    h.addSession("p1");
    h.advance(SWEEP_INTERVAL_MS);
    h.sessions.delete("p1");
    h.advance(HARD_THRESHOLD_MS);
    expect(h.alerts).toEqual([]);
    expect(h.sweep.sessionsAtHardStage()).toEqual([]);
  });

  it("clears episode state for a PTY that disappeared between sweeps", () => {
    const h = harness();
    h.addSession("p1");
    h.advance(HARD_THRESHOLD_MS + SWEEP_INTERVAL_MS);
    expect(h.sweep.sessionsAtHardStage()).toEqual(["p1"]);

    h.sessions.delete("p1");
    h.tick();
    expect(h.sweep.sessionsAtHardStage()).toEqual([]);
  });
});

describe("what an alert carries", () => {
  it("names the session and how long it has been silent", () => {
    const h = harness();
    h.addSession("p1");
    h.advance(SOFT_THRESHOLD_MS + SWEEP_INTERVAL_MS);
    expect(h.alerts[0]).toMatchObject({
      ptyId: "p1",
      taskId: "task-p1",
      title: "session p1",
      project: "proj",
      stage: "soft",
    });
  });

  it("marks a session whose last event was the operator typing", () => {
    const h = harness();
    h.addSession("p1");
    h.sessions.get("p1")!.lastInputMonotonicMs = h.now() + 1;
    h.advance(SOFT_THRESHOLD_MS + SWEEP_INTERVAL_MS);
    expect(h.alerts[0].awaitingOperator).toBe(true);
  });

  it("delivers everything that crossed in one sweep as one batch", () => {
    const batches: SilenceAlert[][] = [];
    let clock = 0;
    const sessions: TrackedPty[] = [];
    const facts = new Map<string, SessionFacts>();
    const sweep = new SilenceSweep({
      now: () => clock,
      listSessions: () => sessions,
      facts: () => facts,
      onAlerts: (batch) => batches.push(batch),
    });
    for (const id of ["a", "b", "c"]) {
      sessions.push({
        ptyId: id,
        transport: "local",
        taskId: id,
        shell: false,
        sandboxInternal: false,
        transportDown: false,
        lastOutputMonotonicMs: 0,
        lastInputMonotonicMs: 0,
      });
      facts.set(id, { title: id, project: null, status: "running", focused: false });
    }
    clock = SOFT_THRESHOLD_MS;
    sweep.tick();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });
});

describe("lifecycle", () => {
  it("starts and stops its interval without leaking a timer", () => {
    vi.useFakeTimers();
    const alerts: SilenceAlert[] = [];
    const sweep = new SilenceSweep({
      listSessions: () => [],
      facts: () => new Map(),
      onAlerts: (batch) => alerts.push(...batch),
    });
    sweep.start();
    sweep.start(); // idempotent
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 3);
    sweep.stop();
    sweep.stop(); // idempotent
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS * 3);
    expect(alerts).toEqual([]);
    vi.useRealTimers();
  });
});
