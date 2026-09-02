/**
 * What a session's header says about the worktree its agent is working in.
 *
 * The agent reports its working directory on every lifecycle event. This
 * resolves that directory against what the project knows, as a pure function of
 * its inputs so the ladder is testable without a running agent — the display is
 * derived on every render rather than stored, so a worktree list that arrives
 * late upgrades a bare path into a named worktree with no further signal.
 *
 * The ladder, in order:
 *   1. No directory reported yet — fall back to the worktree the session was
 *      created against, so a just-started session is not blank (R13).
 *   2. Inside a known worktree — name it (R13). Worktrees are checked before
 *      the project root because they live inside it, except one rooted at the
 *      project itself, which is the main checkout wearing a worktree's clothes.
 *   3. The project's own checkout — say nothing. The main checkout is the
 *      unremarkable case and does not earn a badge (R12). A directory under the
 *      worktree container is excluded: a worktree created moments ago is inside
 *      the project root but is not its main checkout, and reading as "nothing"
 *      would be a wrong answer that the refresh below then corrects.
 *   4. Anywhere else — show the directory itself (R14).
 */

import { WORKTREE_CONTAINER_DIRS } from "./worktrees";

export type SessionWorktreeDisplay =
  | { kind: "hidden" }
  | { kind: "worktree"; worktreeId: string; name: string }
  | { kind: "path"; path: string };

export type SessionWorktreeRef = { id: string; name: string; path: string };

export type SessionWorktreeInput = {
  /** Directory the agent last reported. Null until a lifecycle event arrives. */
  cwd?: string | null;
  /**
   * The project's checkout on the machine this session runs on: the local path
   * for a Local project, the configured remote directory for one on a host.
   */
  projectRoot?: string | null;
  /** Worktrees this project knows about. Empty for a session on a host. */
  worktrees?: readonly SessionWorktreeRef[];
  /** The worktree the session was created against, if not the main checkout. */
  assignedWorktreeId?: string | null;
};

/**
 * Compare paths the way the two sources of them differ: a trailing separator,
 * a Windows backslash, a repeated separator, and the case of a path on a
 * case-insensitive filesystem are all spelling, not meaning. Symlinks are NOT
 * resolved — this runs in the renderer, which has no filesystem, and both
 * sides of the comparison come from the same machine.
 */
function normalizePath(value: string): string {
  const unified = value.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const trimmed = unified.length > 1 ? unified.replace(/\/+$/, "") : unified;
  return trimmed.toLowerCase();
}

function isWithinOrEqual(candidate: string, root: string): boolean {
  if (!root) return false;
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export function resolveSessionWorktree(input: SessionWorktreeInput): SessionWorktreeDisplay {
  const worktrees = input.worktrees ?? [];
  const cwd = input.cwd?.trim();

  const rootPath = input.projectRoot ? normalizePath(input.projectRoot) : "";

  if (!cwd) {
    const assigned = input.assignedWorktreeId
      ? worktrees.find((worktree) => worktree.id === input.assignedWorktreeId)
      : undefined;
    // An assignment pointing at the main checkout is still the main checkout.
    if (!assigned || (rootPath && normalizePath(assigned.path) === rootPath)) {
      return { kind: "hidden" };
    }
    return { kind: "worktree", worktreeId: assigned.id, name: assigned.name };
  }

  const target = normalizePath(cwd);
  const projectRoot = rootPath;

  // Nested worktrees are possible (one adopted inside another's tree), so the
  // deepest containing path wins — it is the one the agent is actually in.
  // A candidate rooted at the project itself is skipped: the list of worktrees
  // a project reports leads with a synthetic row standing for the main
  // checkout, and naming that row would put a label on the one case R12 says
  // gets none.
  let match: SessionWorktreeRef | null = null;
  let matchLength = -1;
  for (const worktree of worktrees) {
    const root = normalizePath(worktree.path);
    if (projectRoot && root === projectRoot) continue;
    if (!isWithinOrEqual(target, root)) continue;
    if (root.length > matchLength) {
      match = worktree;
      matchLength = root.length;
    }
  }
  if (match) return { kind: "worktree", worktreeId: match.id, name: match.name };

  const inWorktreeContainer = WORKTREE_CONTAINER_DIRS.some((dir) =>
    isWithinOrEqual(target, `${projectRoot}/${dir}`),
  );
  if (projectRoot && !inWorktreeContainer && isWithinOrEqual(target, projectRoot)) {
    return { kind: "hidden" };
  }

  return { kind: "path", path: cwd };
}
