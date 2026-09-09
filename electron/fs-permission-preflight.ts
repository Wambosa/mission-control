import { createProbeDeps, probeDeclaredLocationQueued } from "./fs-permission-probe";
import { mergeFsPermissionRecords, readFsPermissionRecords } from "./fs-permission-state";
import {
  DECLARED_LOCATIONS,
  type FsPermissionCategory,
  type FsPermissionOutcome,
  type FsPermissionRecord,
  type DeclaredLocation,
} from "../src/shared/fs-permission";

/**
 * Ask macOS for the protected locations once, at launch, while there is a
 * window to attach the prompt to — and hold the first session start until it
 * has been asked.
 *
 * What the gate is not for. It does not prevent the main-process freeze;
 * `session-scaffolding.ts` does that, and it depends on nothing here. The
 * gate's purpose is narrower and worth stating plainly: enumerating each
 * location registers the app in the OS privacy list, so the Diagnostics jump
 * has a row to target, and it raises the prompts against a visible window
 * rather than in the middle of a session.
 *
 * Why the deadline is load-bearing. A consent prompt has no documented timeout.
 * A sweep that only resolves when every prompt is answered would strand every
 * session behind a dialog the operator may never see — a prompt can appear on a
 * second display, or behind another app. So the sweep resolves either way, and
 * an unanswered category is reported as `pending`: the honest claim, and one
 * that upgrades itself if the operator answers later.
 *
 * Startup never waits on any of this (R4). Only local agent spawns do (R19);
 * remote spawns scaffold on another machine and touch no local protected path,
 * so making them hostage to a local dialog would be a bug, not symmetry (R27).
 */

export type PreflightDeps = {
  platform: NodeJS.Platform;
  probeLocation: (location: DeclaredLocation) => Promise<FsPermissionOutcome>;
  recordOutcomes: (
    outcomes: ReadonlyArray<{ category: FsPermissionCategory; outcome: FsPermissionOutcome }>,
    checkedAt: number,
  ) => void;
  now: () => number;
  deadlineMs: number;
  /** Called as each location settles, so a renderer can show progress. */
  onUpdate?: (records: FsPermissionRecord[]) => void;
};

/**
 * Long enough that an operator who sees the dialog and answers is never cut
 * off; short enough that a session started at launch is not stranded for
 * minutes if they never do. Bounds the whole sweep, not each probe — five
 * per-probe deadlines would multiply into an unbounded wait.
 */
const PREFLIGHT_DEADLINE_MS = 45_000;

type PreflightState = {
  started: boolean;
  resolved: boolean;
  outcomes: Map<FsPermissionCategory, FsPermissionOutcome>;
  checkedAt: number | null;
  gate: Promise<void>;
  openGate: () => void;
};

function freshState(): PreflightState {
  let openGate = () => {};
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return { started: false, resolved: false, outcomes: new Map(), checkedAt: null, gate, openGate };
}

let state = freshState();

/** Test-only: drop the module-scoped sweep so each test starts from nothing. */
export function __resetPreflightForTests(): void {
  state = freshState();
}

export function fsPermissionPreflightRecords(): FsPermissionRecord[] {
  return DECLARED_LOCATIONS.map((location) => {
    const outcome = state.outcomes.get(location.category);
    return {
      category: location.category,
      outcome: outcome ?? "never-probed",
      checkedAt: outcome ? state.checkedAt : null,
    };
  });
}

export function isFsPermissionPreflightResolved(): boolean {
  return state.resolved;
}

/** Resolves when every anticipated category has been asked, or the deadline passed. */
export function awaitFsPermissionPreflight(): Promise<void> {
  return state.gate;
}

function defaultProbeLocation(location: DeclaredLocation): Promise<FsPermissionOutcome> {
  return probeDeclaredLocationQueued(location, createProbeDeps());
}

/**
 * Start the sweep. Idempotent — macOS re-runs window creation on reactivation,
 * and the gate must resolve exactly once.
 *
 * Never rejects and never throws: a failure anywhere inside must not reach
 * startup (R4).
 */
export function startFsPermissionPreflight(overrides: Partial<PreflightDeps> = {}): void {
  if (state.started) return;
  state.started = true;

  const deps: PreflightDeps = {
    platform: process.platform,
    probeLocation: defaultProbeLocation,
    recordOutcomes: () => {},
    now: () => Date.now(),
    deadlineMs: PREFLIGHT_DEADLINE_MS,
    ...overrides,
  };

  const local = state;
  const publish = () => {
    local.checkedAt = deps.now();
    try {
      deps.onUpdate?.(fsPermissionPreflightRecords());
    } catch {
      /* a renderer push must never break the sweep */
    }
  };
  const persist = () => {
    try {
      deps.recordOutcomes(
        [...local.outcomes].map(([category, outcome]) => ({ category, outcome })),
        local.checkedAt ?? deps.now(),
      );
    } catch {
      /* the store is a convenience here, not the sweep's purpose */
    }
  };
  const finish = () => {
    if (local.resolved) return;
    // Whatever has not answered yet is pending, not unknown and not denied.
    for (const location of DECLARED_LOCATIONS) {
      if (!local.outcomes.has(location.category)) local.outcomes.set(location.category, "pending");
    }
    local.resolved = true;
    local.checkedAt = deps.now();
    persist();
    publish();
    local.openGate();
  };

  // No consent model, nothing to ask: never make a session wait for a dialog
  // that cannot exist.
  if (deps.platform !== "darwin") {
    local.resolved = true;
    local.openGate();
    return;
  }

  const deadline = setTimeout(finish, deps.deadlineMs);
  deadline.unref?.();

  void (async () => {
    for (const location of DECLARED_LOCATIONS) {
      let outcome: FsPermissionOutcome;
      try {
        outcome = await deps.probeLocation(location);
      } catch {
        // A probe that throws taught us nothing; it did not deny us.
        outcome = "never-probed";
      }
      // A late answer to a probe the deadline already gave up on is still the
      // truth, and better than the `pending` standing in for it.
      local.outcomes.set(location.category, outcome);
      local.checkedAt = deps.now();
      if (local.resolved) {
        persist();
        publish();
      } else {
        publish();
      }
    }
    clearTimeout(deadline);
    finish();
  })();
}

/**
 * The truest view available right now: this launch's sweep where it has
 * answered, and what an earlier launch recorded everywhere else.
 *
 * Both readers need the same answer — the Diagnostics rows and the note written
 * into a session's context — and a session spawned mid-sweep must not be told
 * "never checked" about a location a previous launch found blocked.
 */
export function currentFsPermissionRecords(userDataDir: string): FsPermissionRecord[] {
  const live = fsPermissionPreflightRecords();
  if (state.resolved) return live;
  return mergeFsPermissionRecords(readFsPermissionRecords(userDataDir), live);
}
