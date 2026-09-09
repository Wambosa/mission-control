import { describe, expect, it, vi } from "vitest";
import {
  blocksScaffolding,
  runSessionScaffolding,
  unreadableCwdNotice,
  type SessionScaffoldingDeps,
  type SessionScaffoldingParams,
} from "../session-scaffolding";
import type { FsPermissionOutcome } from "../../src/shared/fs-permission";
import type { ScaffoldingDirent, ScaffoldingFs } from "../../src/shared/scaffolding-fs";

/** A filesystem that records every call and answers as if nothing exists. */
function recordingFs(overrides: Partial<ScaffoldingFs> = {}) {
  const calls: Array<{ op: string; target: string }> = [];
  const record = <T>(op: string, target: string, value: T): T => {
    calls.push({ op, target });
    return value;
  };
  const fs: ScaffoldingFs = {
    exists: async (target) => record("exists", target, false),
    readFile: async (file) => {
      calls.push({ op: "readFile", target: file });
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    },
    writeFile: async (file) => record("writeFile", file, undefined),
    mkdir: async (dir) => record("mkdir", dir, undefined),
    readdir: async (dir) => record("readdir", dir, [] as ScaffoldingDirent[]),
    copyFile: async (from) => record("copyFile", from, undefined),
    rm: async (target) => record("rm", target, undefined),
    ...overrides,
  };
  return { fs, calls };
}

type HarnessOverrides = Partial<Omit<SessionScaffoldingDeps, "fs">> & {
  fs?: Partial<ScaffoldingFs>;
};

function harness(
  outcome: FsPermissionOutcome,
  overrides: HarnessOverrides = {},
  params: Partial<SessionScaffoldingParams> = {},
) {
  const { fs: fsOverrides, ...depOverrides } = overrides;
  const { fs, calls } = recordingFs(fsOverrides);
  const installHooks = vi.fn();
  const ensureStatuslineTap = vi.fn();
  const installMemoryBrief = vi.fn(async () => {});
  const installPermissionNote = vi.fn(async () => {});
  const fetchRecallEnabled = vi.fn(async () => null as boolean | null);

  const deps: SessionScaffoldingDeps = {
    fs,
    probeCwd: async () => outcome,
    fetchRecallEnabled,
    installHooks,
    ensureStatuslineTap,
    installMemoryBrief,
    installPermissionNote,
    ...depOverrides,
  };

  const run = () =>
    runSessionScaffolding({
      appPath: "/app",
      cwd: "/Users/tester/Documents/project",
      agent: "claude-code",
      taskId: "t-1",
      mcEnv: null,
      petEnabled: true,
      isAgentSession: true,
      fsPermissionRecords: [],
      ...params,
      deps,
    });

  return {
    run,
    calls,
    installHooks,
    ensureStatuslineTap,
    installMemoryBrief,
    installPermissionNote,
    fetchRecallEnabled,
  };
}

describe("blocksScaffolding", () => {
  it("stops on positive evidence of a block, and on no answer at all", () => {
    expect(blocksScaffolding("privacy-blocked")).toBe(true);
    expect(blocksScaffolding("filesystem-blocked")).toBe(true);
    expect(blocksScaffolding("pending")).toBe(true);
  });

  it("lets the fail-soft helpers proceed for every other outcome", () => {
    expect(blocksScaffolding("readable")).toBe(false);
    expect(blocksScaffolding("absent")).toBe(false);
    expect(blocksScaffolding("never-probed")).toBe(false);
    expect(blocksScaffolding("unknowable")).toBe(false);
  });
});

describe("runSessionScaffolding", () => {
  it("runs every step when the cwd probe reports readable", async () => {
    const h = harness("readable");
    await expect(h.run()).resolves.toEqual({ ran: true });

    expect(h.installHooks).toHaveBeenCalledTimes(1);
    expect(h.fetchRecallEnabled).toHaveBeenCalledTimes(1);
    expect(h.ensureStatuslineTap).toHaveBeenCalledWith("/Users/tester/Documents/project");
    expect(h.installMemoryBrief).toHaveBeenCalledTimes(1);
    expect(h.calls.length).toBeGreaterThan(0);
  });

  it("still writes the project-memory brief on the readable path", async () => {
    const h = harness("readable");
    await h.run();
    expect(h.installMemoryBrief).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "claude-code", taskId: "t-1" }),
    );
  });

  // The assertion that carries the thread-pool protection: one gated call per
  // spawn (the probe), not one per scaffolding read.
  it("issues no filesystem call at all when the cwd probe reports a privacy block", async () => {
    const h = harness("privacy-blocked");
    await expect(h.run()).resolves.toEqual({ ran: false, reason: "privacy-blocked" });

    expect(h.calls).toEqual([]);
    expect(h.installHooks).not.toHaveBeenCalled();
    expect(h.fetchRecallEnabled).not.toHaveBeenCalled();
    expect(h.ensureStatuslineTap).not.toHaveBeenCalled();
    expect(h.installMemoryBrief).not.toHaveBeenCalled();
    expect(h.installPermissionNote).not.toHaveBeenCalled();
  });

  it("issues nothing for a filesystem block or an unanswered probe either", async () => {
    for (const outcome of ["filesystem-blocked", "pending"] as const) {
      const h = harness(outcome);
      await expect(h.run()).resolves.toEqual({ ran: false, reason: outcome });
      expect(h.calls).toEqual([]);
    }
  });

  it("never issues the recursive skill removal against a blocked directory", async () => {
    const h = harness("privacy-blocked", { fetchRecallEnabled: vi.fn(async () => false) });
    await h.run();
    expect(h.calls.filter((call) => call.op === "rm")).toEqual([]);
  });

  it("does not accumulate filesystem work across repeated spawns into a blocked directory", async () => {
    // The failure a naive async conversion introduces: each blocked spawn holds
    // another libuv pool thread until promise-based filesystem work everywhere
    // in main stops completing. Nothing is issued, so nothing accumulates.
    const h = harness("privacy-blocked");
    for (let i = 0; i < 8; i += 1) await h.run();
    expect(h.calls).toEqual([]);
  });

  it("installs hooks but skips the agent scaffolding for a shell terminal", async () => {
    const h = harness("readable", {}, { isAgentSession: false, agent: undefined });
    await expect(h.run()).resolves.toEqual({ ran: true });
    expect(h.installHooks).toHaveBeenCalledTimes(1);
    expect(h.fetchRecallEnabled).not.toHaveBeenCalled();
    expect(h.installMemoryBrief).not.toHaveBeenCalled();
  });

  it("leaves the event loop free while a scaffolding read is outstanding", async () => {
    // Every scaffolding call is asynchronous, so a read that never settles
    // parks a pool thread rather than the main thread. Proven by driving other
    // main-process work to completion while the scaffolding is still pending.
    const never = new Promise<never>(() => {});
    const h = harness("readable", {
      fs: { readFile: () => never, exists: () => never },
    });

    let scaffoldingSettled = false;
    void h.run().then(() => {
      scaffoldingSettled = true;
    });

    const otherWork: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      otherWork.push(i);
    }

    expect(otherWork).toEqual([0, 1, 2]);
    expect(scaffoldingSettled).toBe(false);
  });
});

describe("unreadableCwdNotice", () => {
  it("names the directory and points a privacy block at the recovery path", () => {
    const notice = unreadableCwdNotice("/Users/tester/Documents/vault", "privacy-blocked");
    expect(notice).toContain("/Users/tester/Documents/vault");
    expect(notice).toContain("Diagnostics");
  });

  it("does not send a filesystem block to the privacy pane", () => {
    const notice = unreadableCwdNotice("/srv/locked", "filesystem-blocked");
    expect(notice).toContain("/srv/locked");
    expect(notice).not.toContain("Diagnostics");
  });

  it("says a prompt may still be waiting when the probe never answered", () => {
    expect(unreadableCwdNotice("/somewhere", "pending")).toContain("consent prompt");
  });
});
