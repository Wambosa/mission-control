import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { MemoryFileFs } from "./scaffolding-fs";

// Writes into the file each agent auto-loads at startup, as marker-delimited
// managed blocks (mirrors agent-hooks.ts's `_mcManaged` approach). Single
// source of truth; re-exported from electron/agent-memory-file.ts.
//
// Privacy (decision D2 — app-private only): the brief goes into a file that is
// git-ignored so project memory never lands in a commit. Claude Code's
// `CLAUDE.local.md` is both auto-loaded AND conventionally git-ignored, so it is
// the Phase 1 target. Other agents lack a guaranteed private auto-load file, so
// they are intentionally omitted here until a private channel is settled for
// each (adding one is a single entry in AGENT_MEMORY_TARGETS).
//
// Two blocks share this file, and their lifecycles must not touch. The Recall
// brief is removed whenever its fetch fails; the permission note is written
// from a record at spawn. A single-block writer would have each erase the
// other, so every operation names the block it owns and rewrites only that one.
//
// Every filesystem call here is asynchronous and takes its filesystem as a
// parameter: this file runs against the session's working directory, which may
// sit under a macOS-protected location where a synchronous read would park the
// Electron main thread behind a consent prompt.

export type AgentMemoryBlock = "recall" | "permissions";

type BlockMarkers = { start: string; end: string; startPrefix: string };

const BLOCK_MARKERS: Record<AgentMemoryBlock, BlockMarkers> = {
  // The Recall markers are unchanged on purpose: an in-flight file written by
  // an earlier build must keep being recognised, not orphaned beside a new one.
  recall: {
    start:
      "<!-- mc:recall:start (managed by Mission Control — do not edit inside these markers) -->",
    end: "<!-- mc:recall:end -->",
    startPrefix: "<!-- mc:recall:start",
  },
  permissions: {
    start:
      "<!-- mc:permissions:start (managed by Mission Control — do not edit inside these markers) -->",
    end: "<!-- mc:permissions:end -->",
    startPrefix: "<!-- mc:permissions:start",
  },
};

/** The real filesystem, asynchronous. */
export const nodeMemoryFileFs: MemoryFileFs = {
  async exists(target) {
    try {
      await fsp.access(target);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (file) => fsp.readFile(file, "utf8"),
  writeFile: (file, data) => fsp.writeFile(file, data, "utf8"),
  async mkdir(dir) {
    await fsp.mkdir(dir, { recursive: true });
  },
};

type MemoryTarget = {
  /** Path segments of the auto-loaded file, relative to the session cwd. */
  file: string[];
  /** Whether to ensure the file is git-ignored (keeps memory private). */
  gitIgnore: boolean;
};

const AGENT_MEMORY_TARGETS: Record<string, MemoryTarget | undefined> = {
  "claude-code": { file: ["CLAUDE.local.md"], gitIgnore: true },
  // codex / opencode / cursor-cli: deferred — see note above.
};

/** Whether Recall can inject a brief for this agent today. */
export function supportsMemoryInjection(agent: string | undefined): boolean {
  return !!agent && !!AGENT_MEMORY_TARGETS[agent];
}

/** Remove one managed block from `content`, leaving everything else intact. */
function stripBlock(content: string, markers: BlockMarkers): string {
  const start = content.indexOf(markers.startPrefix);
  if (start === -1) return content;
  const endAt = content.indexOf(markers.end, start);
  if (endAt === -1) return content; // malformed — don't clobber user content
  const before = content.slice(0, start).replace(/\s+$/, "");
  const after = content.slice(endAt + markers.end.length).replace(/^\s+/, "");
  return [before, after].filter(Boolean).join("\n\n").trim();
}

/**
 * Append `relPath` to the repo's `.gitignore` if the session cwd is a git root
 * and the path isn't already ignored. Best-effort; never throws.
 */
async function ensureGitIgnored(
  cwd: string,
  relPath: string,
  fs: MemoryFileFs,
): Promise<void> {
  try {
    // `.git` is a dir at a repo root and a file inside a worktree — both count.
    if (!(await fs.exists(path.join(cwd, ".git")))) return;
    const gitignore = path.join(cwd, ".gitignore");
    let content = "";
    try {
      content = await fs.readFile(gitignore);
    } catch {
      /* no .gitignore yet */
    }
    const existing = new Set(content.split(/\r?\n/).map((l) => l.trim()));
    if (existing.has(relPath) || existing.has(`/${relPath}`)) return;
    const prefix = content && !content.endsWith("\n") ? "\n" : "";
    const addition = `${prefix}\n# Mission Control Recall (project memory) — private, do not commit\n${relPath}\n`;
    await fs.writeFile(gitignore, content + addition);
  } catch {
    /* best-effort */
  }
}

/**
 * Write/refresh one managed block in the agent's auto-load file, leaving every
 * other block and all user content untouched. Empty `content` removes that
 * block only. Returns true when a supported agent's file was touched. Never
 * throws — injection must never block a session from starting.
 */
export async function writeAgentMemoryBlock(
  agent: string | undefined,
  cwd: string,
  block: AgentMemoryBlock,
  content: string,
  fs: MemoryFileFs = nodeMemoryFileFs,
): Promise<boolean> {
  if (!agent) return false;
  const target = AGENT_MEMORY_TARGETS[agent];
  if (!target) return false;

  const markers = BLOCK_MARKERS[block];
  const file = path.join(cwd, ...target.file);
  let existing = "";
  try {
    existing = await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }

  const base = stripBlock(existing, markers);
  const trimmed = content.trim();
  let next: string;
  if (!trimmed) {
    next = base ? `${base}\n` : "";
  } else {
    const rendered = `${markers.start}\n${trimmed}\n${markers.end}\n`;
    next = base ? `${base}\n\n${rendered}` : rendered;
  }

  try {
    // Nothing to write and no file existed → don't create an empty file.
    if (!next && !existing) return false;
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, next);
  } catch {
    return false;
  }

  if (trimmed && target.gitIgnore) await ensureGitIgnored(cwd, target.file.join("/"), fs);
  return true;
}

/**
 * Write/refresh the managed Recall block. An empty `brief` removes the block —
 * and only that block, so a failed fetch can no longer take the permission note
 * with it.
 */
export function writeAgentMemoryFile(
  agent: string | undefined,
  cwd: string,
  brief: string,
  fs: MemoryFileFs = nodeMemoryFileFs,
): Promise<boolean> {
  return writeAgentMemoryBlock(agent, cwd, "recall", brief, fs);
}

/** Strip the Recall block from the agent's file (e.g. when Recall is disabled). */
export async function removeAgentMemoryFile(
  agent: string | undefined,
  cwd: string,
  fs: MemoryFileFs = nodeMemoryFileFs,
): Promise<void> {
  await writeAgentMemoryBlock(agent, cwd, "recall", "", fs);
}
