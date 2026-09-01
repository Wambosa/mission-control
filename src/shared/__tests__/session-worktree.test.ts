import { describe, expect, it } from "vitest";
import { resolveSessionWorktree } from "../session-worktree";

const PROJECT_ROOT = "/Users/dev/code/mission-control";
const WORKTREES = [
  { id: "wt-1", name: "quiet-falcon-42", path: `${PROJECT_ROOT}/.worktree/quiet-falcon-42` },
  { id: "wt-2", name: "brisk-otter-07", path: `${PROJECT_ROOT}/.worktree/brisk-otter-07` },
];

describe("resolveSessionWorktree", () => {
  // AE1: nothing has been reported yet, so the session says what it was
  // created against rather than going blank.
  it("falls back to the session's assigned worktree before any directory arrives", () => {
    expect(
      resolveSessionWorktree({
        cwd: null,
        projectRoot: PROJECT_ROOT,
        worktrees: WORKTREES,
        assignedWorktreeId: "wt-2",
      }),
    ).toEqual({ kind: "worktree", worktreeId: "wt-2", name: "brisk-otter-07" });
  });

  it("shows nothing before any directory arrives for a main-checkout session", () => {
    expect(
      resolveSessionWorktree({ cwd: null, projectRoot: PROJECT_ROOT, worktrees: WORKTREES }),
    ).toEqual({ kind: "hidden" });
  });

  // AE2
  it("names the worktree a reported directory sits inside", () => {
    expect(
      resolveSessionWorktree({
        cwd: `${PROJECT_ROOT}/.worktree/quiet-falcon-42/src/server`,
        projectRoot: PROJECT_ROOT,
        worktrees: WORKTREES,
        assignedWorktreeId: null,
      }),
    ).toEqual({ kind: "worktree", worktreeId: "wt-1", name: "quiet-falcon-42" });
  });

  it("prefers the reported directory over the assignment when they disagree", () => {
    expect(
      resolveSessionWorktree({
        cwd: WORKTREES[1]!.path,
        projectRoot: PROJECT_ROOT,
        worktrees: WORKTREES,
        assignedWorktreeId: "wt-1",
      }),
    ).toEqual({ kind: "worktree", worktreeId: "wt-2", name: "brisk-otter-07" });
  });

  // AE3
  it("shows nothing for the project's own checkout", () => {
    expect(
      resolveSessionWorktree({ cwd: PROJECT_ROOT, projectRoot: PROJECT_ROOT, worktrees: WORKTREES }),
    ).toEqual({ kind: "hidden" });
    expect(
      resolveSessionWorktree({
        cwd: `${PROJECT_ROOT}/src/components`,
        projectRoot: PROJECT_ROOT,
        worktrees: WORKTREES,
      }),
    ).toEqual({ kind: "hidden" });
  });

  // AE4: still unresolved after the caller's one refresh.
  it("shows the directory itself when it matches nothing the project knows", () => {
    expect(
      resolveSessionWorktree({
        cwd: "/Users/dev/scratch/spike",
        projectRoot: PROJECT_ROOT,
        worktrees: WORKTREES,
      }),
    ).toEqual({ kind: "path", path: "/Users/dev/scratch/spike" });
  });

  it("resolves as a worktree once the refreshed list contains it", () => {
    const cwd = `${PROJECT_ROOT}/.worktree/new-badger-13`;
    expect(
      resolveSessionWorktree({ cwd, projectRoot: PROJECT_ROOT, worktrees: WORKTREES }),
    ).toEqual({ kind: "path", path: cwd });
    expect(
      resolveSessionWorktree({
        cwd,
        projectRoot: PROJECT_ROOT,
        worktrees: [...WORKTREES, { id: "wt-3", name: "new-badger-13", path: cwd }],
      }),
    ).toEqual({ kind: "worktree", worktreeId: "wt-3", name: "new-badger-13" });
  });

  it("tolerates trailing slashes, doubled separators, backslashes, and case", () => {
    for (const cwd of [
      `${PROJECT_ROOT}/.worktree/quiet-falcon-42/`,
      `${PROJECT_ROOT}//.worktree//quiet-falcon-42`,
      `${PROJECT_ROOT}/.worktree/QUIET-FALCON-42`,
      `${PROJECT_ROOT}\\.worktree\\quiet-falcon-42`,
    ]) {
      expect(resolveSessionWorktree({ cwd, projectRoot: PROJECT_ROOT, worktrees: WORKTREES })).toEqual({
        kind: "worktree",
        worktreeId: "wt-1",
        name: "quiet-falcon-42",
      });
    }
  });

  it("does not mistake a sibling directory with a shared prefix for a worktree", () => {
    const cwd = `${PROJECT_ROOT}/.worktree/quiet-falcon-42-old`;
    // Unresolved, not "quiet-falcon-42" — and not hidden either, since a
    // directory under the worktree container is never the main checkout.
    expect(
      resolveSessionWorktree({ cwd, projectRoot: PROJECT_ROOT, worktrees: WORKTREES }),
    ).toEqual({ kind: "path", path: cwd });
  });

  it("does not read a worktree created moments ago as the main checkout", () => {
    const cwd = `${PROJECT_ROOT}/.worktrees/legacy-container-worktree`;
    expect(
      resolveSessionWorktree({ cwd, projectRoot: PROJECT_ROOT, worktrees: WORKTREES }),
    ).toEqual({ kind: "path", path: cwd });
  });

  it("picks the deepest worktree when one is nested inside another", () => {
    const outer = { id: "wt-outer", name: "outer", path: "/Users/dev/code/outer" };
    const inner = { id: "wt-inner", name: "inner", path: "/Users/dev/code/outer/.worktree/inner" };
    expect(
      resolveSessionWorktree({
        cwd: `${inner.path}/src`,
        projectRoot: PROJECT_ROOT,
        worktrees: [outer, inner],
      }),
    ).toEqual({ kind: "worktree", worktreeId: "wt-inner", name: "inner" });
  });

  // A session on an SSH host: worktree discovery reads this machine only, so
  // the list is empty and the project's configured remote directory is the
  // root the comparison runs against.
  it("shows nothing for a remote session sitting in the configured remote directory", () => {
    expect(
      resolveSessionWorktree({
        cwd: "/home/dev/work/mission-control",
        projectRoot: "/home/dev/work/mission-control",
        worktrees: [],
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("shows the directory for a remote session elsewhere on the host", () => {
    expect(
      resolveSessionWorktree({
        cwd: "/home/dev/other/repo",
        projectRoot: "/home/dev/work/mission-control",
        worktrees: [],
      }),
    ).toEqual({ kind: "path", path: "/home/dev/other/repo" });
  });

  it("treats a blank directory as no signal rather than an unresolved path", () => {
    expect(
      resolveSessionWorktree({
        cwd: "   ",
        projectRoot: PROJECT_ROOT,
        worktrees: WORKTREES,
        assignedWorktreeId: "wt-1",
      }),
    ).toEqual({ kind: "worktree", worktreeId: "wt-1", name: "quiet-falcon-42" });
  });
});
