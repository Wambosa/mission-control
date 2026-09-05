import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The session header states the worktree its agent is working in, and that
// statement comes from the working directory the agent reports on every
// lifecycle event. These pin the recording half; the resolution half is a pure
// function covered in src/shared/__tests__/session-worktree.test.ts.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-agent-cwd-hook-test-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const { handleApiRequest } = await import("../api-router");
const { getOrCreateApiToken } = await import("../services/settings");
const { createProject } = await import("../services/projects");
const { createTask, getTask } = await import("../services/tasks");
const { getDb } = await import("~/db/client");
const { projects, tasks, groups, appSettings, worktrees } = await import("~/db/schema");

const SESSION_ID = "00000000-0000-4000-8000-000000000000";

function authed(input: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:5173${input}`, {
    ...init,
    headers: {
      origin: "http://127.0.0.1:5173",
      authorization: `Bearer ${getOrCreateApiToken()}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function postHook(taskId: string, body: Record<string, unknown>): Promise<Response | null> {
  return handleApiRequest(
    authed(`/api/hooks/claude?taskId=${encodeURIComponent(taskId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

let taskId = "";
let projectPath = "";

beforeEach(() => {
  const db = getDb();
  db.delete(tasks).run();
  db.delete(worktrees).run();
  db.delete(projects).run();
  db.delete(groups).run();
  db.delete(appSettings).run();
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "mc-agent-cwd-proj-"));
  const project = createProject({ name: "cwd", path: projectPath });
  taskId = createTask({
    projectId: project.id,
    title: "Session",
    agent: "claude-code",
    claudeSessionId: null,
  }).id;
});

describe("agent working directory", () => {
  it("starts unknown, so the header falls back to the session's assignment", () => {
    expect(getTask(taskId)?.agentCwd).toBeNull();
  });

  it("records the directory a lifecycle event reports", async () => {
    const cwd = path.join(projectPath, ".worktree", "quiet-falcon-42");
    const res = await postHook(taskId, {
      hook_event_name: "UserPromptSubmit",
      session_id: SESSION_ID,
      prompt: "move into the worktree",
      cwd,
    });

    expect(res?.status).toBe(200);
    expect(getTask(taskId)?.agentCwd).toBe(cwd);
  });

  it("follows the agent as it moves", async () => {
    await postHook(taskId, { hook_event_name: "SessionStart", session_id: SESSION_ID, cwd: projectPath });
    expect(getTask(taskId)?.agentCwd).toBe(projectPath);

    const moved = path.join(projectPath, ".worktree", "brisk-otter-07");
    await postHook(taskId, { hook_event_name: "UserPromptSubmit", session_id: SESSION_ID, prompt: "x", cwd: moved });
    expect(getTask(taskId)?.agentCwd).toBe(moved);
  });

  // R13: an event with nothing to say about the directory must not blank the
  // header — the last known directory is still the best answer available.
  it("leaves the recorded directory alone when an event carries none", async () => {
    await postHook(taskId, { hook_event_name: "SessionStart", session_id: SESSION_ID, cwd: projectPath });
    await postHook(taskId, { hook_event_name: "Stop", session_id: SESSION_ID });
    expect(getTask(taskId)?.agentCwd).toBe(projectPath);

    await postHook(taskId, { hook_event_name: "Stop", session_id: SESSION_ID, cwd: "   " });
    expect(getTask(taskId)?.agentCwd).toBe(projectPath);
  });

  // A subagent reports its own directory; labeling the session with it would
  // claim the session moved when it did not.
  it("ignores the directory on subagent lifecycle events", async () => {
    await postHook(taskId, { hook_event_name: "SessionStart", session_id: SESSION_ID, cwd: projectPath });
    await postHook(taskId, {
      hook_event_name: "SubagentStart",
      session_id: SESSION_ID,
      agent_id: "sub-1",
      cwd: "/somewhere/else",
    });
    expect(getTask(taskId)?.agentCwd).toBe(projectPath);
  });
});
