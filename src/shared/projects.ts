import type { Project, TaskStatus } from "~/db/schema";

export type ProjectWithCounts = Project & {
  taskCounts: Record<TaskStatus, number> & { total: number; activeNonDone: number };
  preview?: string | null;
  githubUrl?: string | null;
  /**
   * Normalized `host/owner/repo` git-remote key (any host, not just GitHub), or
   * null for local-only repos. Used by the multiplayer-pets feature, which
   * hashes it before it leaves the machine — see ~/shared/repo-key.
   */
  repoKey?: string | null;
};

export type ProjectPathStatus =
  | { ok: true; path: string; scope: "project" | "worktree"; worktreeId?: string | null }
  | {
      ok: false;
      path: string;
      scope: "project" | "worktree";
      worktreeId?: string | null;
      reason: "missing" | "not-directory" | "unreadable";
      message: string;
    };

export type ProjectActivityState =
  | "offline"
  | "agent-running"
  | "needs-input"
  | "interrupted";

export function getProjectActivity(project: ProjectWithCounts): ProjectActivityState {
  if (project.taskCounts.interrupted > 0) return "interrupted";
  if (project.taskCounts["needs-input"] > 0) return "needs-input";
  if (project.taskCounts.running > 0) return "agent-running";
  return "offline";
}

export function isProjectActive(activity: ProjectActivityState): boolean {
  return activity !== "offline";
}
