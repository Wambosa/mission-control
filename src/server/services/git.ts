import * as fs from "node:fs";
import * as path from "node:path";
import { spawnCapture } from "./_spawn";
import { resolveProjectWorktreeCwd } from "./worktrees";
import {
  DIFF_MAX_BYTES,
  DIFF_MAX_LINES,
  parsePorcelainZ,
  parseGitBranchHeader,
  classifyDiffPatch,
  buildAdditionsDiff,
  bufferLooksBinary,
  changedFileCount,
} from "~/shared/git-status";

// parsePorcelainZ / parseGitBranchHeader are re-exported so existing importers
// (git.test.ts) keep working.
export { parsePorcelainZ, parseGitBranchHeader };

const GIT_TIMEOUT_MS = 15_000;

// Git result types + diff caps now live in src/shared/git-status.ts so the
// remote sandbox agent shares the exact wire contract. Imported for this
// module's own signatures and re-exported for existing importers (GitDiffView,
// ~/queries/git, git.test.ts).
import type { GitFileStatus, GitChangedFile, GitStatus, GitDiff } from "~/shared/git-status";
export type { GitFileStatus, GitChangedFile, GitStatus, GitDiff };

class GitError extends Error {
  constructor(message: string, public stderr?: string) {
    super(message);
    this.name = "GitError";
  }
}

/** Checkout refused because the branch is already checked out in another
 * worktree — switching should repoint the UI at that worktree, not run git. */
export class BranchInWorktreeError extends GitError {
  constructor(
    message: string,
    public readonly worktreeId: string,
    public readonly worktreeName: string,
  ) {
    super(message);
    this.name = "BranchInWorktreeError";
  }
}

function projectCwd(projectId: string, worktreeId?: string | null): string {
  try {
    return resolveProjectWorktreeCwd(projectId, worktreeId);
  } catch (e) {
    throw new GitError(e instanceof Error ? e.message : String(e));
  }
}

type RunGitResult = { stdout: string; stderr: string; code: number };

function runGit(
  cwd: string,
  args: string[],
  options: { timeoutMs?: number; encoding?: "utf8" | "buffer" } = {},
): Promise<RunGitResult> {
  const { timeoutMs = GIT_TIMEOUT_MS } = options;
  return spawnCapture("git", args, {
    cwd,
    timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    onTimeout: () => new GitError(`git ${args[0]} timed out`),
  });
}

async function gitOk(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
  const r = await runGit(cwd, args, { timeoutMs });
  if (r.code !== 0) {
    throw new GitError(`git ${args[0]} failed`, r.stderr.trim() || `exit ${r.code}`);
  }
  return r.stdout;
}

// A directory doesn't stop being a work tree mid-session, so cache the positive
// `rev-parse --is-inside-work-tree` result per cwd for the process lifetime —
// this drops one spawn from every getGitStatus poll (and every branch/pull op)
// after the first. Only successes are cached; a later git failure on the same
// cwd invalidates it (see invalidateWorkTreeCache) so a repo that genuinely
// went away is re-checked.
const workTreeCache = new Map<string, boolean>();

function invalidateWorkTreeCache(cwd: string): void {
  workTreeCache.delete(cwd);
}

async function assertGitRepository(cwd: string): Promise<void> {
  if (workTreeCache.get(cwd)) return;
  const r = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (r.code === 0 && r.stdout.trim() === "true") {
    workTreeCache.set(cwd, true);
    return;
  }
  workTreeCache.delete(cwd);
  throw new GitError(
    "Project folder is not a Git repository.",
    r.stderr.trim() || "Run git init in this folder to enable branches and worktrees.",
  );
}


// mapStatusCode + parsePorcelainZ now live in ~/shared/git-status (imported and
// re-exported above) so the remote agent's git RPC parses identically.

export async function getGitStatus(projectId: string, worktreeId?: string | null): Promise<GitStatus> {
  const cwd = projectCwd(projectId, worktreeId);
  await assertGitRepository(cwd);
  // `-b` prepends a `## <branch>...<upstream> [ahead N, behind M]` header to the
  // same porcelain output, so one spawn yields the branch name AND the
  // ahead/behind counts against the upstream — replacing the old symbolic-ref +
  // two rev-list spawns. In `-z` mode the header is the first NUL-terminated
  // token; the file entries follow and still feed parsePorcelainZ unchanged.
  let statusOut: string;
  try {
    statusOut = await gitOk(cwd, ["status", "--porcelain=v1", "-b", "-z", "-uall"]);
  } catch (e) {
    // The dir may have stopped being a work tree (e.g. .git removed); drop the
    // cached positive so the next call re-checks.
    invalidateWorkTreeCache(cwd);
    throw e;
  }
  const nul = statusOut.indexOf("\0");
  const headerLine = nul >= 0 ? statusOut.slice(0, nul) : statusOut;
  const entriesOut = nul >= 0 ? statusOut.slice(nul + 1) : "";
  const header = parseGitBranchHeader(headerLine);
  const { staged, unstaged } = parsePorcelainZ(entriesOut);
  // With an upstream the header already carries both counts. Without one, the
  // header omits them: preserve the old fallback — ahead against origin/main →
  // main (one extra spawn, only in the no-upstream case), behind stays null (no
  // tracking ref to measure against, exactly as before).
  const aheadCount = header.hasUpstream ? header.ahead : await countAhead(cwd);
  const behindCount = header.hasUpstream ? header.behind : null;
  return {
    branch: header.branch || "HEAD",
    staged,
    unstaged,
    changedCount: changedFileCount(staged, unstaged),
    aheadCount,
    behindCount,
  };
}

// No-upstream fallback for the ahead count: the branch header supplies ahead/
// behind whenever an upstream exists, so this only runs when it doesn't — and
// `@{u}` would necessarily fail there. Mirror the old fallback order
// (origin/main → main) so a fresh feature branch still reports commits ahead of
// the default branch.
async function countAhead(cwd: string): Promise<number | null> {
  for (const target of ["origin/main", "main"]) {
    const r = await runGit(cwd, ["rev-list", "--count", `${target}..HEAD`]);
    if (r.code === 0) {
      const n = parseInt(r.stdout.trim(), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export async function getGitDiff(
  projectId: string,
  file: string,
  staged: boolean,
  worktreeId?: string | null,
): Promise<GitDiff> {
  const cwd = projectCwd(projectId, worktreeId);

  // Untracked files have no index entry — `git diff` emits nothing. Synthesize
  // a unified-diff-style payload so the UI can render +lines for new files.
  if (!staged) {
    const statusOut = await gitOk(cwd, ["status", "--porcelain=v1", "-z", "--", file]);
    if (statusOut.startsWith("??")) {
      return readUntrackedAsDiff(cwd, file);
    }
  }

  const args = staged
    ? ["diff", "--cached", "--", file]
    : ["diff", "--", file];
  const r = await runGit(cwd, args);
  if (r.code !== 0) {
    throw new GitError("git diff failed", r.stderr.trim() || `exit ${r.code}`);
  }
  return classifyDiffPatch(r.stdout);
}

/** Render an untracked file as a unified-diff-style patch (all lines as additions). */
function readUntrackedAsDiff(cwd: string, file: string): GitDiff {
  try {
    const root = path.resolve(cwd);
    const abs = path.resolve(root, file);
    // Defense-in-depth: even though `git status` already gates this branch,
    // refuse to read anything outside the repo root.
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new GitError("path escapes project root");
    }
    const stat = fs.statSync(abs);
    if (stat.size > DIFF_MAX_BYTES) {
      return { kind: "too-large", lines: 0, bytes: stat.size };
    }
    const buf = fs.readFileSync(abs);
    if (bufferLooksBinary(buf)) return { kind: "binary" };
    const text = buf.toString("utf8");
    const lineCount = text.split("\n").length;
    if (lineCount > DIFF_MAX_LINES) {
      return { kind: "too-large", lines: lineCount, bytes: stat.size };
    }
    return { kind: "text", patch: buildAdditionsDiff(file, text), truncated: false };
  } catch (e: any) {
    throw new GitError("could not read untracked file", e?.message || String(e));
  }
}

export async function stageFiles(
  projectId: string,
  files: string[],
  worktreeId?: string | null,
): Promise<void> {
  if (files.length === 0) return;
  const cwd = projectCwd(projectId, worktreeId);
  await gitOk(cwd, ["add", "--", ...files]);
}

export async function deleteProjectFile(
  projectId: string,
  relPath: string,
  worktreeId?: string | null,
): Promise<void> {
  if (!relPath || relPath.trim() === "") {
    throw new GitError("file path is required");
  }
  const cwd = projectCwd(projectId, worktreeId);
  const abs = path.resolve(cwd, relPath);
  const rootWithSep = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  if (abs !== cwd && !abs.startsWith(rootWithSep)) {
    throw new GitError("path escapes project root");
  }
  if (abs === cwd) {
    throw new GitError("refusing to delete project root");
  }
  // The lexical check above collapses `..`, but a *symlinked intermediate
  // directory* inside the repo (e.g. `link -> /etc`, then delete `link/passwd`)
  // resolves lexically inside root while `fs.rm` follows it out of the project.
  // Realpath the parent directory and re-check containment so the delete target
  // physically lives under the project root.
  try {
    const realRoot = fs.realpathSync(cwd);
    const realParent = fs.realpathSync(path.dirname(abs));
    const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (realParent !== realRoot && !realParent.startsWith(realRootWithSep)) {
      throw new GitError("path escapes project root");
    }
  } catch (e: any) {
    if (e instanceof GitError) throw e;
    if (e?.code === "ENOENT") return; // parent already gone → nothing to delete
    throw new GitError("could not resolve file path", e?.message || String(e));
  }
  try {
    await fs.promises.rm(abs, { force: false });
  } catch (e: any) {
    if (e?.code === "ENOENT") return; // already gone
    if (e?.code === "EISDIR") {
      throw new GitError("path is a directory");
    }
    throw new GitError("could not delete file", e?.message || String(e));
  }
}

export async function unstageFiles(
  projectId: string,
  files: string[],
  worktreeId?: string | null,
): Promise<void> {
  if (files.length === 0) return;
  const cwd = projectCwd(projectId, worktreeId);
  // `git reset HEAD --` works whether or not HEAD has any history.
  const r = await runGit(cwd, ["reset", "HEAD", "--", ...files]);
  // `git reset` exits 1 on partial when no HEAD yet; treat fatal errors only.
  if (r.code !== 0 && /fatal:/i.test(r.stderr)) {
    // Empty repo (no HEAD) — fall back to `rm --cached` to unstage.
    if (/ambiguous argument 'HEAD'/i.test(r.stderr)) {
      await gitOk(cwd, ["rm", "--cached", "--", ...files]);
      return;
    }
    throw new GitError("git reset failed", r.stderr.trim());
  }
}

export type GitErrorPayload = {
  message: string;
  stderr?: string;
  kind?: "branch-in-worktree";
  /** Owning worktree when kind === "branch-in-worktree" — the client repoints to it. */
  worktreeId?: string;
  worktreeName?: string;
};

/** Merge local and remote branch lists into deduplicated checkout targets. */
export function gitErrorPayload(e: unknown): GitErrorPayload {
  if (e instanceof BranchInWorktreeError) {
    return {
      message: e.message,
      kind: "branch-in-worktree",
      worktreeId: e.worktreeId,
      worktreeName: e.worktreeName,
    };
  }
  if (e instanceof GitError) {
    return { message: e.message, stderr: e.stderr };
  }
  return { message: e instanceof Error ? e.message : String(e) };
}
