import { describe, expect, it } from "vitest";
import {
  silenceDecision,
  unavailableCredit,
  type SessionFacts,
  type SilenceInput,
} from "../silence-policy";

const SOFT = 5 * 60_000;
const HARD = 10 * 60_000;

function facts(overrides: Partial<SessionFacts> = {}): SessionFacts {
  return { title: "a session", project: "proj", status: "running", focused: false, ...overrides };
}

function input(overrides: Partial<SilenceInput> = {}): SilenceInput {
  return {
    silentAwakeMs: 0,
    softThresholdMs: SOFT,
    hardThresholdMs: HARD,
    stage: "none",
    shell: false,
    sandboxInternal: false,
    transportDown: false,
    facts: facts(),
    inputAfterLastOutput: false,
    ...overrides,
  };
}

describe("threshold boundaries", () => {
  it("stays quiet just under the soft threshold and alerts exactly at it", () => {
    expect(silenceDecision(input({ silentAwakeMs: SOFT - 1 })).action).toBe("none");
    const at = silenceDecision(input({ silentAwakeMs: SOFT }));
    expect(at.action).toBe("alert-soft");
    expect(at.stage).toBe("soft");
    expect(at.reason).toBe("soft-threshold-crossed");
  });

  it("stays at soft just under the hard threshold and escalates exactly at it", () => {
    expect(silenceDecision(input({ silentAwakeMs: HARD - 1, stage: "soft" })).action).toBe("none");
    const at = silenceDecision(input({ silentAwakeMs: HARD, stage: "soft" }));
    expect(at.action).toBe("alert-hard");
    expect(at.stage).toBe("hard");
  });

  it("escalates straight to hard when a session crosses both between sweeps", () => {
    expect(silenceDecision(input({ silentAwakeMs: HARD + 1, stage: "none" })).action).toBe(
      "alert-hard",
    );
  });

  it("raises no action for a session producing output continuously", () => {
    expect(silenceDecision(input({ silentAwakeMs: 0 })).action).toBe("none");
    expect(silenceDecision(input({ silentAwakeMs: 1_000 })).reason).toBe("below-soft");
  });
});

describe("one alert per threshold per episode", () => {
  it("does not alert again at soft within the same episode", () => {
    const second = silenceDecision(input({ silentAwakeMs: SOFT + 60_000, stage: "soft" }));
    expect(second.action).toBe("none");
    expect(second.reason).toBe("already-alerted");
    expect(second.stage).toBe("soft");
  });

  it("does not alert again at hard within the same episode", () => {
    const second = silenceDecision(input({ silentAwakeMs: HARD + 60_000, stage: "hard" }));
    expect(second.action).toBe("none");
    expect(second.reason).toBe("already-alerted");
    expect(second.stage).toBe("hard");
  });

  it("alerts again once the episode has been re-armed", () => {
    // Re-arming is the sweep's job — it resets the stage when output resumes.
    // From the policy's side, a fresh episode is simply stage "none" again.
    expect(silenceDecision(input({ silentAwakeMs: SOFT, stage: "none" })).action).toBe(
      "alert-soft",
    );
  });
});

describe("suppression", () => {
  const wellPastHard = { silentAwakeMs: HARD * 2 };

  it("never alerts a shell pane", () => {
    const d = silenceDecision(input({ ...wellPastHard, shell: true }));
    expect(d.action).toBe("none");
    expect(d.reason).toBe("shell-pane");
  });

  it("never alerts the sandbox agent's own upgrade PTY", () => {
    expect(silenceDecision(input({ ...wellPastHard, sandboxInternal: true })).reason).toBe(
      "sandbox-internal",
    );
  });

  it("reports a dropped transport as unreachable rather than silent", () => {
    expect(silenceDecision(input({ ...wellPastHard, transportDown: true })).reason).toBe(
      "transport-down",
    );
  });

  it("never alerts a session the operator is looking at", () => {
    expect(
      silenceDecision(input({ ...wellPastHard, facts: facts({ focused: true }) })).reason,
    ).toBe("session-focused");
  });

  it("never alerts a session waiting on an operator answer", () => {
    expect(
      silenceDecision(input({ ...wellPastHard, facts: facts({ status: "needs-input" }) })).reason,
    ).toBe("status-awaiting-input");
  });

  it("never alerts an interrupted session", () => {
    expect(
      silenceDecision(input({ ...wellPastHard, facts: facts({ status: "interrupted" }) })).reason,
    ).toBe("status-interrupted");
  });

  it("never alerts a session whose task has reached a terminal state", () => {
    for (const status of ["finished", "terminated"] as const) {
      expect(silenceDecision(input({ ...wellPastHard, facts: facts({ status }) })).reason).toBe(
        "status-terminal",
      );
    }
  });

  it("holds a session whose facts have not been pushed rather than alerting it", () => {
    // Fail closed: alerting without status would breach the requirement that a
    // legitimately idle session stays quiet.
    const d = silenceDecision(input({ ...wellPastHard, facts: null }));
    expect(d.action).toBe("none");
    expect(d.reason).toBe("facts-unknown");
  });

  it("decides normally once the facts arrive", () => {
    expect(silenceDecision(input({ ...wellPastHard, facts: facts() })).action).toBe("alert-hard");
  });

  it("still alerts a session that is merely ready or running", () => {
    for (const status of ["ready", "running"] as const) {
      expect(silenceDecision(input({ silentAwakeMs: SOFT, facts: facts({ status }) })).action).toBe(
        "alert-soft",
      );
    }
  });
});

describe("waiting on the operator", () => {
  it("carries whether the last event was the operator typing", () => {
    expect(
      silenceDecision(input({ silentAwakeMs: SOFT, inputAfterLastOutput: true })).awaitingOperator,
    ).toBe(true);
    expect(silenceDecision(input({ silentAwakeMs: SOFT })).awaitingOperator).toBe(false);
  });
});

describe("unavailableCredit", () => {
  const base = {
    expectedIntervalMs: 15_000,
    toleranceMs: 5_000,
    largeGapMs: 120_000,
    resumeObserved: false,
  };

  it("credits nothing for a gap within tolerance", () => {
    expect(unavailableCredit({ ...base, gapMs: 18_000 })).toBe(0);
    expect(unavailableCredit({ ...base, gapMs: 20_000 })).toBe(0);
  });

  it("credits the excess when a resume event classified the gap", () => {
    const gapMs = 8 * 60 * 60_000;
    expect(unavailableCredit({ ...base, gapMs, resumeObserved: true })).toBe(
      gapMs - base.expectedIntervalMs,
    );
  });

  it("credits nothing for a long gap with no resume, below the fallback", () => {
    // The gap the app's own freeze produces. Crediting it would let a stalled
    // main thread silently mask real silence.
    expect(unavailableCredit({ ...base, gapMs: 90_000 })).toBe(0);
  });

  it("credits a very large gap even with no resume observed", () => {
    const gapMs = 4 * 60 * 60_000;
    expect(unavailableCredit({ ...base, gapMs })).toBe(gapMs - base.expectedIntervalMs);
  });

  it("credits nothing for a gap shorter than the interval", () => {
    expect(unavailableCredit({ ...base, gapMs: 1_000 })).toBe(0);
  });
});
