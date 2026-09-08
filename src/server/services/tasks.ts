import { DEFAULT_BRANCH, DEFAULT_TASK_STATUS, isTaskAgent, isTaskStatus } from "~/shared/domain";
import type { TaskAgent, TaskStatus } from "~/shared/domain";
import type { Task } from "~/db/schema";
import { events } from "../events";
import { deleteDiagramsForTask } from "./diagram-store";
import { clearPendingQuestion } from "./pending-questions";
import { clearSubagentActivity } from "./subagent-activity";
import {
  deleteTaskRow,
  findActiveLocalTasks,
  findTaskById,
  findTasksByProjectId,
  insertTask,
  updateTaskRow,
} from "../repositories/tasks.repo";
import { findProjectNameById } from "../repositories/projects.repo";
import {
  findTerminalLogsByTaskId,
  insertTerminalLogs,
  trimTerminalLogsForTask,
} from "../repositories/terminal-logs.repo";
import { logServerEvent } from "../log-event";
import { newId } from "./_ids";
import { isClientDomainId } from "../../shared/client-id";
import { normalizeProjectScopeId } from "./sandbox-scope";

export function listTasksForProject(projectId: string): Task[] {
  return findTasksByProjectId(projectId);
}

export function getTask(id: string): Task | null {
  return findTaskById(id);
}

export function createTask(input: {
  id?: string;
  projectId: string;
  worktreeId?: string | null;
  scopeId?: string | null;
  title: string;
  agent: TaskAgent;
  branch?: string;
  status?: TaskStatus;
  preview?: string;
  claudeSessionId?: string | null;
  claudeSkipPermissions?: boolean;
  claudeBareSession?: boolean;
}): Task {
  if (!input.projectId) throw new Error("projectId required");
  if (!input.title?.trim()) throw new Error("title required");
  if (!isTaskAgent(input.agent)) throw new Error("invalid agent");
  const scopeId = normalizeProjectScopeId(input.projectId, input.scopeId);

  const now = Date.now();
  const requestedId = input.id?.trim();
  if (requestedId && !isClientDomainId(requestedId)) throw new Error("invalid task id");
  if (requestedId && findTaskById(requestedId)) throw new Error("task id already exists");
  const row: Task = {
    id: requestedId || newId("t"),
    projectId: input.projectId,
    worktreeId: input.worktreeId ?? null,
    scopeId,
    title: input.title.trim(),
    titleManuallySet: false,
    icon: null,
    agent: input.agent,
    status: input.status ?? DEFAULT_TASK_STATUS,
    branch: input.branch || DEFAULT_BRANCH,
    preview: input.preview ?? "",
    lines: 0,
    archived: false,
    pinned: false,
    claudeSessionId: input.claudeSessionId ?? null,
    claudeSkipPermissions: input.claudeSkipPermissions ?? false,
    claudeBareSession: input.claudeBareSession ?? false,
    // No lifecycle event has arrived yet; the header falls back to the
    // worktree this session was created against until one does.
    agentCwd: null,
    createdAt: now,
    updatedAt: now,
  };
  insertTask(row);
  logServerEvent("session.created", {
    taskId: row.id,
    projectId: row.projectId,
    agent: row.agent,
    scopeId: row.scopeId,
  });
  events.emit("task:created", { id: row.id, projectId: row.projectId });
  return row;
}

export function updateStatus(
  id: string,
  patch: { status?: TaskStatus; preview?: string; lines?: number }
): Task | null {
  if (patch.status && !isTaskStatus(patch.status)) throw new Error("invalid status");
  const existing = findTaskById(id);
  if (!existing) return null;
  const next = {
    ...existing,
    status: patch.status ?? existing.status,
    preview: patch.preview ?? existing.preview,
    lines: patch.lines ?? existing.lines,
    updatedAt: Date.now(),
  };
  updateTaskRow(id, {
    status: next.status,
    preview: next.preview,
    lines: next.lines,
    updatedAt: next.updatedAt,
  });
  events.emit("task:updated", { id, projectId: existing.projectId });
  // Any status transition away from needs-input means the agent moved on, so
  // whatever question was pending is stale (answered, cancelled, interrupted).
  if (patch.status && patch.status !== "needs-input") {
    clearPendingQuestion(id);
  }
  // A dead or detached terminal takes its session's subagents with it; their
  // tracked entries must not hold a future session of this task on "running".
  if (patch.status === "terminated" || patch.status === "disconnected") {
    clearSubagentActivity(id);
  }
  if (
    patch.status === "finished" &&
    existing.status !== "finished"
  ) {
    const projectName = findProjectNameById(existing.projectId);
    events.emit("session:finished", {
      id,
      projectId: existing.projectId,
      worktreeId: existing.worktreeId ?? null,
      scopeId: existing.scopeId,
      projectName: projectName ?? "Project",
      taskTitle: existing.title,
    });
  }
  return next;
}

/**
 * Startup sweep: mark every local-scope task still claiming a live agent
 * process (running / needs-input) as disconnected. Called by Electron main
 * once per app boot, before the first window loads — at that point no local
 * PTYs exist, so any such status is an orphan of a previous run (app quit or
 * crash killed the process before any hook could report). Goes through
 * updateStatus so events fire and stale subagent tracking is dropped.
 */
export function sweepOrphanedActiveTasks(): number {
  const orphans = findActiveLocalTasks();
  for (const t of orphans) {
    updateStatus(t.id, { status: "disconnected" });
  }
  return orphans.length;
}

export function updateTask(
  id: string,
  patch: Partial<
    Pick<
      Task,
      | "title"
      | "titleManuallySet"
      | "icon"
      | "branch"
      | "pinned"
      | "claudeSessionId"
      | "claudeSkipPermissions"
      | "claudeBareSession"
    >
  >
): Task | null {
  const existing = findTaskById(id);
  if (!existing) return null;
  const next = { ...existing, ...patch, updatedAt: Date.now() };
  updateTaskRow(id, next);
  // Pinning is one field among several this function serves, so the event is
  // gated on the value actually changing — otherwise a title edit would report
  // a pin, and re-pinning an already-pinned session would report a second one.
  if (patch.pinned !== undefined && patch.pinned !== existing.pinned) {
    logServerEvent("session.pinned", {
      taskId: id,
      projectId: existing.projectId,
      pinned: patch.pinned,
    });
  }
  events.emit("task:updated", { id, projectId: existing.projectId });
  return next;
}

/**
 * Record the directory the session's agent reports working in.
 *
 * Separate from updateTask because this is the only writer and it must stay
 * quiet: a lifecycle hook fires many times a turn, almost always naming the
 * same directory, and emitting task:updated for an unchanged value would churn
 * every session subscriber for nothing. A blank or missing directory is no
 * signal at all and leaves the stored one alone — the header keeps saying what
 * it last knew rather than blanking (R13).
 *
 * Takes the row rather than an id: the hook handler has already loaded it, and
 * this runs on every event of every open session.
 */
export function recordAgentCwd(existing: Task, cwd: string | undefined): Task {
  const next = cwd?.trim();
  if (!next || existing.agentCwd === next) return existing;
  const updated = { ...existing, agentCwd: next, updatedAt: Date.now() };
  updateTaskRow(existing.id, updated);
  events.emit("task:updated", { id: existing.id, projectId: existing.projectId });
  return updated;
}

export function archiveTask(id: string): Task | null {
  const existing = findTaskById(id);
  if (!existing) return null;
  updateTaskRow(id, { archived: true, updatedAt: Date.now() });
  const next = { ...existing, archived: true } as Task;
  clearPendingQuestion(id);
  logServerEvent("session.archived", { taskId: id, projectId: existing.projectId });
  events.emit("task:archived", { id, projectId: existing.projectId });
  return next;
}

export function restoreTask(id: string): Task | null {
  const existing = findTaskById(id);
  if (!existing) return null;
  updateTaskRow(id, { archived: false, updatedAt: Date.now() });
  const next = { ...existing, archived: false } as Task;
  logServerEvent("session.restored", { taskId: id, projectId: existing.projectId });
  events.emit("task:restored", { id, projectId: existing.projectId });
  return next;
}

export function deleteTask(id: string): boolean {
  const existing = findTaskById(id);
  if (!existing) return false;
  const changes = deleteTaskRow(id);
  if (changes > 0) {
    deleteDiagramsForTask(id);
    clearPendingQuestion(id);
    logServerEvent("session.deleted", { taskId: id, projectId: existing.projectId });
    events.emit("task:deleted", { id, projectId: existing.projectId });
    return true;
  }
  return false;
}

/**
 * Retained output per session (R24). Matches the in-memory replay ring in
 * electron/pty-manager.ts, so what survives a restart is the same window the
 * live terminal would have replayed.
 *
 * This bounds ONE session. Nothing bounds the total across sessions: archiving
 * a session keeps its output, and only deleting it reclaims the rows through
 * the cascade. That is a known, recorded gap rather than an oversight.
 */
const TRANSCRIPT_BUDGET_BYTES = 1_000_000;

/**
 * How much new output a session may accumulate before its size is re-checked.
 *
 * The bound is enforced on a trigger rather than per write: a trim reads the
 * session's rows, and doing that on every flush is the full per-task scan the
 * previous implementation did. The consequence is that R24 is *eventually*
 * enforced — a crash between an insert and its trim leaves a session
 * temporarily over budget, never corrupt.
 *
 * Set to the batcher's own force-flush ceiling so a saturated session is
 * checked roughly once per forced flush. Worth measuring against a real
 * session; it is a throughput/overshoot dial, not a correctness one.
 */
const TRIM_CHECK_BYTES = 262_144;

/** Bytes written per task since that task's last trim. Reset by the trim. */
const bytesSinceTrim = new Map<string, number>();

/**
 * A strictly increasing creation stamp for retained chunks.
 *
 * Wall-clock milliseconds alone are not enough: several flushes land inside one
 * millisecond under load, and the row id cannot break the tie because it ends
 * in random hex — so two batches from the same millisecond would read back in
 * arbitrary order. This never returns a value it has already returned, which
 * gives the trim and the read a total order.
 *
 * Under a burst the stamp runs slightly ahead of the clock. That is the right
 * trade: this column exists to order a session's output, and it is never shown
 * to anyone as a timestamp.
 */
let lastCreatedAt = 0;
function nextCreatedAt(): number {
  const now = Date.now();
  lastCreatedAt = now > lastCreatedAt ? now : lastCreatedAt + 1;
  return lastCreatedAt;
}

/**
 * Persist a batch of terminal output for a session (R23).
 *
 * Never throws for a missing task: the batches arrive fire-and-forget from the
 * main process, and one can land after its task is deleted — the same
 * existence-check-then-write shape recordPrompt uses, for the same reason. A
 * batch for a task that is gone is dropped, not raised, because the cascade has
 * already removed everything it would have been attached to.
 */
export function appendTerminalOutput(taskId: string, chunks: readonly string[]): boolean {
  if (chunks.length === 0) return true;
  // The foreign key would reject this anyway; checking first keeps a constraint
  // error out of the request handler.
  if (!findTaskById(taskId)) return false;

  const rows = chunks
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => ({
      id: newId("tl"),
      taskId,
      chunk,
      createdAt: nextCreatedAt(),
    }));
  if (rows.length === 0) return true;

  insertTerminalLogs(rows);

  const written = rows.reduce((total, row) => total + Buffer.byteLength(row.chunk, "utf8"), 0);
  const pending = (bytesSinceTrim.get(taskId) ?? 0) + written;
  if (pending < TRIM_CHECK_BYTES) {
    bytesSinceTrim.set(taskId, pending);
    return true;
  }

  // Reset before trimming: a trim that throws must not make every later flush
  // retry it, and the next flush past the threshold will try again.
  bytesSinceTrim.set(taskId, 0);
  trimTerminalLogsForTask(taskId, TRANSCRIPT_BUDGET_BYTES);
  return true;
}

/** A session's retained output, oldest first (R23). */
export function readTerminalLog(taskId: string): string {
  return findTerminalLogsByTaskId(taskId)
    .map((r) => r.chunk)
    .join("");
}

/** Test-only: drop the in-memory trim counters and the creation stamp. */
export function __resetTranscriptTrimStateForTesting(): void {
  bytesSinceTrim.clear();
  lastCreatedAt = 0;
}
