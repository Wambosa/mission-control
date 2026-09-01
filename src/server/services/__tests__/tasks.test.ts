import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-tasks-test-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const { createProject } = await import("../projects");
const { createTask, listTasksForProject } = await import("../tasks");
const { getDb } = await import("~/db/client");
const { projects, tasks, userTerminals, worktrees, sandboxes } = await import("~/db/schema");

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-task-project-"));
  return createProject({ name: "p", path: dir });
}

function makeSandbox(id: string, projectId: string) {
  const now = Date.now();
  getDb()
    .insert(sandboxes)
    .values({
      id,
      name: "Sandbox",
      kind: "remote-vm",
      color: null,
      imageTag: null,
      dockerfilePath: null,
      buildArgs: null,
      gitAuthMode: "none",
      copyAgentCreds: false,
      declaredPorts: null,
      env: null,
      hostAgentPort: null,
      portMap: null,
      pairingToken: null,
      remoteConfig: JSON.stringify({ agentUrl: "wss://agent.example.com/", projectId }),
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("tasks service", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(userTerminals).run();
    db.delete(worktrees).run();
    db.delete(tasks).run();
    db.delete(projects).run();
    db.delete(sandboxes).run();
  });

  // A session belongs to its project. Where it ran is recorded on the row, but
  // it never decides whether the project's own screen shows the session — so
  // moving a project to another host does not hide the work done on the last one.
  it("lists every session for the project, whatever scope it ran on", () => {
    const p = makeProject();
    makeSandbox("sb-1", p.id);
    makeSandbox("sb-2", p.id);
    createTask({ projectId: p.id, title: "Local", agent: "claude-code", scopeId: "local" });
    createTask({ projectId: p.id, title: "Old host", agent: "claude-code", scopeId: "sb-1" });
    createTask({ projectId: p.id, title: "New host", agent: "claude-code", scopeId: "sb-2" });

    expect(
      listTasksForProject(p.id)
        .map((task: { title: string }) => task.title)
        .sort(),
    ).toEqual(["Local", "New host", "Old host"]);
  });

  it("keeps each session's recorded scope", () => {
    const p = makeProject();
    makeSandbox("sb-1", p.id);
    createTask({ projectId: p.id, title: "Local", agent: "claude-code", scopeId: "local" });
    createTask({ projectId: p.id, title: "Remote", agent: "claude-code", scopeId: "sb-1" });

    const byTitle = new Map(
      listTasksForProject(p.id).map((task: { title: string; scopeId: string }) => [
        task.title,
        task.scopeId,
      ]),
    );
    expect(byTitle.get("Local")).toBe("local");
    expect(byTitle.get("Remote")).toBe("sb-1");
  });

  it("rejects tasks for an unknown sandbox scope", () => {
    const p = makeProject();
    expect(() =>
      createTask({ projectId: p.id, title: "Missing", agent: "claude-code", scopeId: "sb-missing" }),
    ).toThrow("Sandbox scope does not exist");
  });
});
