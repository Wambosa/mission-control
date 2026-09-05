// Routes git status/diff reads to the host repo (HTTP API) or to the project's
// own machine (remoteGit RPC), by the project's scope. Only status + diff are
// agent-supported; staging stays on the HTTP path. Default-preserved: with no
// scope, every call is exactly the prior `api.*` behavior.
import { api } from "~/lib/api";
import { isRemoteProjectFs, type ProjectFsScope } from "~/lib/project-fs";
import type { GitStatus, GitDiff } from "~/shared/git-status";

const LOCAL_SCOPE: ProjectFsScope = { sandboxId: null, remoteDirectory: null };

export async function fetchGitStatus(
  projectId: string,
  worktreeId: string | null | undefined,
  sandboxRepoPath?: string,
  scope: ProjectFsScope = LOCAL_SCOPE,
): Promise<GitStatus> {
  if (sandboxRepoPath && window.electronAPI && (await isRemoteProjectFs(scope))) {
    const status = await window.electronAPI.remoteGit.status(scope.sandboxId, sandboxRepoPath);
    // The sandbox agent's git RPC predates behindCount and doesn't compute it,
    // so the wire object is missing the field its GitStatus type claims.
    return { ...status, behindCount: status.behindCount ?? null };
  }
  return api.getGitStatus(projectId, worktreeId);
}

export async function fetchGitDiff(
  projectId: string,
  file: string,
  staged: boolean,
  worktreeId: string | null | undefined,
  sandboxRepoPath?: string,
  scope: ProjectFsScope = LOCAL_SCOPE,
): Promise<GitDiff> {
  if (sandboxRepoPath && window.electronAPI && (await isRemoteProjectFs(scope))) {
    return window.electronAPI.remoteGit.diff(scope.sandboxId, sandboxRepoPath, file, staged);
  }
  return api.getGitDiff(projectId, file, staged, worktreeId);
}
