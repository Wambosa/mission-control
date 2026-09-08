import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-terminal-retention-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

vi.mock("../repositories/terminal-logs.repo", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../repositories/terminal-logs.repo")>();
  return {
    ...actual,
    findTerminalLogsByTaskId: vi.fn(actual.findTerminalLogsByTaskId),
    trimTerminalLogsForTask: vi.fn(actual.trimTerminalLogsForTask),
    insertTerminalLogs: vi.fn(actual.insertTerminalLogs),
  };
});

const { getDb, getSqlite } = await import("~/db/client");
const { projects, tasks, terminalLogs } = await import("~/db/schema");
const { handleApiRequest } = await import("../api-router");
const { getOrCreateApiToken } = await import("../services/settings");
const projectService = await import("../services/projects");
const taskService = await import("../services/tasks");
const repo = await import("../repositories/terminal-logs.repo");

/** The retained budget the service enforces, mirrored so the tests can overshoot it. */
const BUDGET_BYTES = 1_000_000;
/** How much new output triggers a size re-check. */
const TRIM_CHECK_BYTES = 262_144;

function authed(input: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${getOrCreateApiToken()}`);
  }
  return new Request(input, { ...init, headers });
}

function makeProjectDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${label}-`));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function newTask() {
  const project = projectService.createProject({ path: makeProjectDir("proj"), name: "proj" });
  return taskService.createTask({
    projectId: project.id,
    title: "a session",
    agent: "claude-code",
  });
}

function retainedBytes(taskId: string): number {
  return repo
    .findTerminalLogsByTaskId(taskId)
    .reduce((total, row) => total + Buffer.byteLength(row.chunk, "utf8"), 0);
}

beforeEach(() => {
  getDb().delete(terminalLogs).run();
  getDb().delete(tasks).run();
  getDb().delete(projects).run();
  taskService.__resetTranscriptTrimStateForTesting();
  vi.mocked(repo.findTerminalLogsByTaskId).mockReset();
  vi.mocked(repo.trimTerminalLogsForTask).mockReset();
  vi.mocked(repo.insertTerminalLogs).mockReset();
});

describe("appendTerminalOutput", () => {
  it("persists a batch of chunks and reads it back in order", () => {
    const task = newTask();
    expect(taskService.appendTerminalOutput(task.id, ["one ", "two ", "three"])).toBe(true);
    expect(taskService.readTerminalLog(task.id)).toBe("one two three");
  });

  it("appends across batches in the order they arrived", () => {
    const task = newTask();
    taskService.appendTerminalOutput(task.id, ["a"]);
    taskService.appendTerminalOutput(task.id, ["b"]);
    taskService.appendTerminalOutput(task.id, ["c"]);
    expect(taskService.readTerminalLog(task.id)).toBe("abc");
  });

  // The batches arrive fire-and-forget from the main process, so one can land
  // after its task is deleted. The rows would already be gone via the cascade.
  it("drops a batch whose task no longer exists rather than raising", () => {
    const task = newTask();
    taskService.deleteTask(task.id);
    expect(() => taskService.appendTerminalOutput(task.id, ["late"])).not.toThrow();
    expect(taskService.appendTerminalOutput(task.id, ["late"])).toBe(false);
  });

  it("ignores an empty batch and empty chunks", () => {
    const task = newTask();
    expect(taskService.appendTerminalOutput(task.id, [])).toBe(true);
    expect(taskService.appendTerminalOutput(task.id, ["", ""])).toBe(true);
    expect(repo.findTerminalLogsByTaskId(task.id)).toEqual([]);
  });

  it("keeps two sessions' output separate", () => {
    const a = newTask();
    const b = newTask();
    taskService.appendTerminalOutput(a.id, ["mine"]);
    taskService.appendTerminalOutput(b.id, ["theirs"]);
    expect(taskService.readTerminalLog(a.id)).toBe("mine");
    expect(taskService.readTerminalLog(b.id)).toBe("theirs");
  });

  it("survives a restart, since the rows are in the database", () => {
    const task = newTask();
    taskService.appendTerminalOutput(task.id, ["output from a session that died"]);
    // A fresh read through the repository is what a restarted app does.
    expect(repo.findTerminalLogsByTaskId(task.id).map((r) => r.chunk)).toEqual([
      "output from a session that died",
    ]);
  });

  it("removes a session's output when the task is deleted, through the cascade", () => {
    const task = newTask();
    taskService.appendTerminalOutput(task.id, ["gone soon"]);
    expect(repo.findTerminalLogsByTaskId(task.id)).toHaveLength(1);
    taskService.deleteTask(task.id);
    expect(repo.findTerminalLogsByTaskId(task.id)).toEqual([]);
  });
});

describe("retention bound (R24)", () => {
  it("stays under budget after sustained output well past it", () => {
    const task = newTask();
    const chunk = "x".repeat(64 * 1024);
    // ~3x the budget.
    for (let i = 0; i < 48; i += 1) taskService.appendTerminalOutput(task.id, [chunk]);
    expect(retainedBytes(task.id)).toBeLessThanOrEqual(BUDGET_BYTES + TRIM_CHECK_BYTES);
    expect(retainedBytes(task.id)).toBeLessThan(48 * chunk.length);
  });

  it("keeps the newest output and drops the oldest", () => {
    const task = newTask();
    const filler = "f".repeat(64 * 1024);
    taskService.appendTerminalOutput(task.id, ["OLDEST-MARKER"]);
    for (let i = 0; i < 32; i += 1) taskService.appendTerminalOutput(task.id, [filler]);
    taskService.appendTerminalOutput(task.id, ["NEWEST-MARKER"]);
    const retained = taskService.readTerminalLog(task.id);
    expect(retained).toContain("NEWEST-MARKER");
    expect(retained).not.toContain("OLDEST-MARKER");
  });

  it("does not grow with the session", () => {
    const task = newTask();
    const chunk = "y".repeat(64 * 1024);
    for (let i = 0; i < 24; i += 1) taskService.appendTerminalOutput(task.id, [chunk]);
    const afterFirstRun = retainedBytes(task.id);
    for (let i = 0; i < 24; i += 1) taskService.appendTerminalOutput(task.id, [chunk]);
    const afterSecondRun = retainedBytes(task.id);
    // Bounded, not cumulative: twice the output is not twice the storage.
    expect(afterSecondRun).toBeLessThan(afterFirstRun * 2);
  });

  // The previous implementation re-read every row for the task on each call,
  // which at batcher cadence is a full per-task scan per flush per session.
  it("does not read the session's rows on an ordinary write", () => {
    const task = newTask();
    taskService.appendTerminalOutput(task.id, ["warm up"]);
    vi.mocked(repo.findTerminalLogsByTaskId).mockClear();
    vi.mocked(repo.trimTerminalLogsForTask).mockClear();
    vi.mocked(repo.insertTerminalLogs).mockClear();

    taskService.appendTerminalOutput(task.id, ["small"]);

    expect(repo.findTerminalLogsByTaskId).not.toHaveBeenCalled();
    expect(repo.trimTerminalLogsForTask).not.toHaveBeenCalled();
    // The write itself still happened — this is not passing by doing nothing.
    expect(repo.insertTerminalLogs).toHaveBeenCalledTimes(1);
  });

  it("does trim once a session crosses the check threshold", () => {
    // The counterpart to the assertion above: the trigger has to actually fire,
    // or "no trim on the common path" would be true of a bound never enforced.
    const task = newTask();
    const chunk = "t".repeat(TRIM_CHECK_BYTES + 1);
    taskService.appendTerminalOutput(task.id, [chunk]);
    expect(repo.trimTerminalLogsForTask).toHaveBeenCalledWith(task.id, BUDGET_BYTES);
  });

  it("returns to bound on a later flush when a trim fails", () => {
    const task = newTask();
    // Each write on its own crosses the check threshold, so every call trims —
    // which makes the injected failure land on a known call.
    const chunk = "z".repeat(TRIM_CHECK_BYTES + 1);

    // A trim that throws must leave the insert that preceded it standing, and
    // must not be swallowed the way a delivery failure is — a permanently
    // silent trim is indistinguishable from unbounded growth.
    vi.mocked(repo.trimTerminalLogsForTask).mockImplementationOnce(() => {
      throw new Error("trim failed");
    });
    expect(() => taskService.appendTerminalOutput(task.id, [chunk])).toThrow("trim failed");
    expect(taskService.readTerminalLog(task.id)).toContain("z");

    // A later flush trims for real and brings the session back inside its bound.
    for (let i = 0; i < 8; i += 1) taskService.appendTerminalOutput(task.id, [chunk]);
    expect(retainedBytes(task.id)).toBeLessThanOrEqual(BUDGET_BYTES + chunk.length);
  });
});

describe("trimTerminalLogsForTask", () => {
  it("orders by creation time rather than by id", () => {
    const task = newTask();
    // Ids whose lexical order is the reverse of their creation order — the id's
    // encoded timestamp is base36 and changes width, so it is not a time proxy.
    repo.insertTerminalLogs([
      { id: "zzz-oldest", taskId: task.id, chunk: "OLD", createdAt: 1_000 },
      { id: "aaa-newest", taskId: task.id, chunk: "NEW", createdAt: 2_000 },
    ]);
    repo.trimTerminalLogsForTask(task.id, 3);
    expect(taskService.readTerminalLog(task.id)).toBe("NEW");
  });

  it("keeps at least the newest chunk even when it alone exceeds the budget", () => {
    // Otherwise a single oversized batch would trim the table to empty and lose
    // the output entirely rather than bounding it.
    const task = newTask();
    repo.insertTerminalLogs([
      { id: "tl-1", taskId: task.id, chunk: "a".repeat(100), createdAt: 1 },
    ]);
    repo.trimTerminalLogsForTask(task.id, 10);
    expect(repo.findTerminalLogsByTaskId(task.id)).toHaveLength(1);
  });

  it("is a no-op when the session is already inside its budget", () => {
    const task = newTask();
    repo.insertTerminalLogs([{ id: "tl-1", taskId: task.id, chunk: "small", createdAt: 1 }]);
    expect(repo.trimTerminalLogsForTask(task.id, 1_000)).toBe(0);
    expect(repo.findTerminalLogsByTaskId(task.id)).toHaveLength(1);
  });

  it("only trims the session it was asked about", () => {
    const a = newTask();
    const b = newTask();
    repo.insertTerminalLogs([
      { id: "tl-a1", taskId: a.id, chunk: "a".repeat(50), createdAt: 1 },
      { id: "tl-a2", taskId: a.id, chunk: "a".repeat(50), createdAt: 2 },
      { id: "tl-b1", taskId: b.id, chunk: "b".repeat(50), createdAt: 1 },
    ]);
    repo.trimTerminalLogsForTask(a.id, 50);
    expect(repo.findTerminalLogsByTaskId(b.id)).toHaveLength(1);
  });
});

describe("the composite index exists", () => {
  it("indexes (task_id, created_at), which is what the trim sorts on", () => {
    const rows = getSqlite()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'terminal_logs'")
      .all() as { name: string }[];
    expect(rows.map((r) => r.name)).toContain("terminal_logs_task_created_idx");
  });
});

describe("the ingest endpoint", () => {
  it("accepts a batch and persists it", async () => {
    const task = newTask();
    const res = await handleApiRequest(
      authed(`http://127.0.0.1:5173/api/tasks/${task.id}/terminal-output`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chunks: ["hello ", "world"] }),
      }),
    );
    expect(res?.status).toBe(204);
    expect(taskService.readTerminalLog(task.id)).toBe("hello world");
  });

  it("answers 404 for a task that no longer exists, rather than a constraint error", async () => {
    const res = await handleApiRequest(
      authed("http://127.0.0.1:5173/api/tasks/t-gone/terminal-output", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chunks: ["late"] }),
      }),
    );
    expect(res?.status).toBe(404);
  });

  it("rejects a malformed body", async () => {
    const task = newTask();
    const res = await handleApiRequest(
      authed(`http://127.0.0.1:5173/api/tasks/${task.id}/terminal-output`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chunks: "not an array" }),
      }),
    );
    expect(res?.status).toBe(400);
  });

  it("reads a dead session's retained output back", async () => {
    const task = newTask();
    taskService.appendTerminalOutput(task.id, ["what the session printed"]);
    const res = await handleApiRequest(
      authed(`http://127.0.0.1:5173/api/tasks/${task.id}/terminal-output`),
    );
    expect(res?.status).toBe(200);
    expect(await res!.json()).toEqual({ output: "what the session printed" });
  });

  it("answers 404 when reading output for a task that does not exist", async () => {
    const res = await handleApiRequest(
      authed("http://127.0.0.1:5173/api/tasks/t-gone/terminal-output"),
    );
    expect(res?.status).toBe(404);
  });

  it("returns empty output for a session that produced none", async () => {
    const task = newTask();
    const res = await handleApiRequest(
      authed(`http://127.0.0.1:5173/api/tasks/${task.id}/terminal-output`),
    );
    expect(await res!.json()).toEqual({ output: "" });
  });
});

describe("listRetainedTranscripts (the export's only source)", () => {
  it("returns one entry per session that retained output", () => {
    const a = newTask();
    const b = newTask();
    taskService.appendTerminalOutput(a.id, ["from a"]);
    taskService.appendTerminalOutput(b.id, ["from b"]);

    const got = taskService.listRetainedTranscripts();
    expect(got.map((t) => t.taskId).sort()).toEqual([a.id, b.id].sort());
    expect(got.find((t) => t.taskId === a.id)?.output).toBe("from a");
  });

  it("carries the ids and titles a bundle reader needs to identify a session", () => {
    const task = newTask();
    taskService.appendTerminalOutput(task.id, ["out"]);
    const [got] = taskService.listRetainedTranscripts();
    expect(got).toMatchObject({
      taskId: task.id,
      projectId: task.projectId,
      title: task.title,
      archived: false,
    });
  });

  it("excludes a session that retained nothing", () => {
    const withOutput = newTask();
    newTask(); // never writes
    taskService.appendTerminalOutput(withOutput.id, ["only this one"]);
    expect(taskService.listRetainedTranscripts().map((t) => t.taskId)).toEqual([withOutput.id]);
  });

  it("returns an empty list when nothing is retained at all", () => {
    newTask();
    expect(taskService.listRetainedTranscripts()).toEqual([]);
  });

  it("still reports an archived session, since archiving keeps its output", () => {
    const task = newTask();
    taskService.appendTerminalOutput(task.id, ["kept"]);
    taskService.archiveTask(task.id);
    const [got] = taskService.listRetainedTranscripts();
    expect(got).toMatchObject({ taskId: task.id, archived: true });
  });

  it("skips a row whose task is gone rather than throwing", () => {
    // The cascade should make this unreachable; the guard exists so a stale row
    // cannot take the whole export down with it.
    const task = newTask();
    taskService.appendTerminalOutput(task.id, ["orphan"]);
    getSqlite().prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
    expect(() => taskService.listRetainedTranscripts()).not.toThrow();
    expect(taskService.listRetainedTranscripts()).toEqual([]);
  });

  it("serves the same content through the diagnostics route", async () => {
    const task = newTask();
    taskService.appendTerminalOutput(task.id, ["over the wire"]);
    const res = await handleApiRequest(
      authed("http://127.0.0.1:5173/api/diagnostics/transcripts"),
    );
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { transcripts: { taskId: string; output: string }[] };
    expect(body.transcripts).toMatchObject([{ taskId: task.id, output: "over the wire" }]);
  });
});

describe("the composite index on an upgraded database", () => {
  // The fresh-install path is covered above. This is the branch every existing
  // user actually takes: a terminal_logs table that predates the index.
  it("is retrofitted onto a database that lacks it", () => {
    const sqlite = getSqlite();
    sqlite.exec("DROP INDEX IF EXISTS terminal_logs_task_created_idx");
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get("terminal_logs_task_created_idx"),
    ).toBeUndefined();

    // The same idempotent statement ensureSchema runs on every boot.
    sqlite.exec(
      "CREATE INDEX IF NOT EXISTS terminal_logs_task_created_idx ON terminal_logs(task_id, created_at)",
    );
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get("terminal_logs_task_created_idx"),
    ).toMatchObject({ name: "terminal_logs_task_created_idx" });
  });
});
