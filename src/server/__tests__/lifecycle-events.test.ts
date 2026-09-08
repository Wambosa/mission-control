import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-lifecycle-events-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const { getDb } = await import("~/db/client");
const { appSettings, projects, tasks, groups, sandboxes } = await import("~/db/schema");
const { SERVER_EVENT_MARKER } = await import("../log-event");
const { createServerOutputForwarder } = await import("../../../electron/server-output-forwarder");
const projectService = await import("../services/projects");
const taskService = await import("../services/tasks");
const groupService = await import("../services/groups");
const settingService = await import("../services/settings");
const recallSettings = await import("../services/recall-settings");

type Event = { event: string } & Record<string, unknown>;

let stdout: ReturnType<typeof vi.spyOn>;
let lines: string[];

/**
 * Every structured event emitted since the last reset, read back the way an
 * operator would: through main's real line-oriented forwarder rather than a
 * stand-in for it. A mock of the forwarder would not prove the events survive
 * the process boundary they have to cross.
 */
function events(): Event[] {
  const forwarded: string[] = [];
  const forward = createServerOutputForwarder({
    write: (_level, line) => forwarded.push(line),
    isQuitting: () => false,
  });
  for (const line of lines) forward("info", line);
  return forwarded
    .filter((line) => line.includes(SERVER_EVENT_MARKER))
    .map((line) => JSON.parse(line.slice(line.indexOf(SERVER_EVENT_MARKER) + SERVER_EVENT_MARKER.length)) as Event);
}

function named(name: string): Event[] {
  return events().filter((e) => e.event === name);
}

function reset(): void {
  lines = [];
}

function makeProjectDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${label}-`));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  return dir;
}

function newProject(label = "proj") {
  return projectService.createProject({ path: makeProjectDir(label), name: label });
}

function newTask(projectId: string) {
  return taskService.createTask({ projectId, title: "a session", agent: "claude-code" });
}

/** A project's sandboxId is a real foreign key, so a rebind needs a real row. */
function newSandbox(id: string) {
  getDb()
    .insert(sandboxes)
    .values({ id, name: id, kind: "remote-vm", createdAt: Date.now(), updatedAt: Date.now() })
    .run();
  return id;
}

beforeEach(() => {
  getDb().delete(tasks).run();
  getDb().delete(projects).run();
  getDb().delete(sandboxes).run();
  getDb().delete(groups).run();
  getDb().delete(appSettings).run();
  lines = [];
  stdout = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  stdout.mockRestore();
});

describe("session lifecycle events (R9)", () => {
  it("emits one event per transition, each carrying the task and project ids", () => {
    const project = newProject();
    reset();

    const task = newTask(project.id);
    taskService.archiveTask(task.id);
    taskService.restoreTask(task.id);
    taskService.deleteTask(task.id);

    for (const name of [
      "session.created",
      "session.archived",
      "session.restored",
      "session.deleted",
    ]) {
      expect(named(name), name).toHaveLength(1);
      expect(named(name)[0]).toMatchObject({ taskId: task.id, projectId: project.id });
    }
  });

  it("records a pin, and only when the value actually moved", () => {
    const project = newProject();
    const task = newTask(project.id);
    reset();

    taskService.updateTask(task.id, { pinned: true });
    expect(named("session.pinned")).toEqual([
      { event: "session.pinned", taskId: task.id, projectId: project.id, pinned: true },
    ]);

    reset();
    // Re-pinning an already-pinned session changed nothing.
    taskService.updateTask(task.id, { pinned: true });
    expect(named("session.pinned")).toEqual([]);

    reset();
    taskService.updateTask(task.id, { pinned: false });
    expect(named("session.pinned")).toMatchObject([{ pinned: false }]);
  });

  it("stays silent for the other fields the generic update also serves", () => {
    const project = newProject();
    const task = newTask(project.id);
    reset();

    taskService.updateTask(task.id, { title: "renamed" });

    expect(named("session.pinned")).toEqual([]);
  });

  it("emits nothing for a transition on a session that does not exist", () => {
    reset();
    taskService.archiveTask("t-missing");
    taskService.restoreTask("t-missing");
    taskService.deleteTask("t-missing");
    expect(events()).toEqual([]);
  });
});

describe("project lifecycle events (R10)", () => {
  it("records create, edit, and delete against the project id", () => {
    reset();
    const project = newProject();
    expect(named("project.created")).toMatchObject([{ projectId: project.id }]);

    reset();
    projectService.updateProject(project.id, { name: "renamed" });
    expect(named("project.edited")).toMatchObject([
      { projectId: project.id, fields: ["name"] },
    ]);

    reset();
    projectService.deleteProject(project.id);
    expect(named("project.deleted")).toMatchObject([{ projectId: project.id }]);
  });

  it("reports a host rebind as its own event carrying both sides", () => {
    const project = newProject();
    const host = newSandbox("sbx-1");
    reset();

    projectService.updateProject(project.id, { sandboxId: host, remoteDirectory: "/srv/app" });

    expect(named("project.host-changed")).toMatchObject([
      { projectId: project.id, from: null, to: host },
    ]);
  });

  it("does not report a host rebind when the patch names the same host", () => {
    const project = newProject();
    const host = newSandbox("sbx-1");
    projectService.updateProject(project.id, { sandboxId: host, remoteDirectory: "/srv/app" });
    reset();

    projectService.updateProject(project.id, { sandboxId: host, name: "renamed" });

    expect(named("project.host-changed")).toEqual([]);
    expect(named("project.edited")).toMatchObject([{ fields: ["name"] }]);
  });

  it("stays silent for a save that changed nothing", () => {
    const project = newProject();
    reset();
    projectService.updateProject(project.id, { name: project.name });
    expect(named("project.edited")).toEqual([]);
  });

  it("records pinning, which skips the generic update entirely", () => {
    const project = newProject();
    reset();
    projectService.togglePin(project.id);
    expect(named("project.edited")).toMatchObject([
      { projectId: project.id, fields: ["pinned"] },
    ]);
  });

  it("logs field names rather than values, so a path or blob is not copied in", () => {
    const project = newProject();
    reset();
    projectService.updateProject(project.id, { icon: "rocket", iconColor: "#ff0000" });
    const edited = named("project.edited")[0];
    expect(edited.fields).toEqual(["icon", "iconColor"]);
    expect(JSON.stringify(edited)).not.toContain("rocket");
  });
});

describe("group lifecycle events", () => {
  it("records create, edit, and delete against the group id", () => {
    reset();
    const group = groupService.createGroup({ name: "Work" });
    expect(named("group.created")).toMatchObject([{ groupId: group.id }]);

    reset();
    groupService.updateGroup(group.id, { name: "Personal" });
    expect(named("group.edited")).toMatchObject([{ groupId: group.id, fields: ["name"] }]);

    reset();
    groupService.deleteGroup(group.id);
    expect(named("group.deleted")).toMatchObject([{ groupId: group.id }]);
  });

  it("stays silent for a group save that changed nothing", () => {
    const group = groupService.createGroup({ name: "Work" });
    reset();
    groupService.updateGroup(group.id, { name: "Work" });
    expect(named("group.edited")).toEqual([]);
  });
});

describe("setting mutation events (R12)", () => {
  it("records the key with both the previous and the new value", () => {
    settingService.setSetting("default_agent", "claude-code");
    reset();

    settingService.setSetting("default_agent", "codex");

    expect(named("setting.changed")).toEqual([
      { event: "setting.changed", key: "default_agent", from: "claude-code", to: "codex" },
    ]);
  });

  it("reports a first write as coming from no previous value", () => {
    reset();
    settingService.setSetting("default_model", "opus");
    expect(named("setting.changed")).toMatchObject([{ from: null, to: "opus" }]);
  });

  it("reports a delete as landing on no value", () => {
    settingService.setSetting("default_model", "opus");
    reset();
    settingService.deleteSetting("default_model");
    expect(named("setting.changed")).toMatchObject([{ from: "opus", to: null }]);
  });

  it("records a boolean setting's before and after", () => {
    settingService.setBooleanSetting("recall_enabled", false);
    reset();
    settingService.setBooleanSetting("recall_enabled", true);
    expect(named("setting.changed")).toMatchObject([
      { key: "recall_enabled", from: "false", to: "true" },
    ]);
  });

  it("stays silent when a settings save re-sends an unchanged value", () => {
    // Saving a settings page re-sends every field it owns; one click must not
    // become a dozen lines.
    settingService.setBooleanSetting("recall_enabled", true);
    settingService.setSetting("default_agent", "codex");
    reset();

    settingService.setBooleanSetting("recall_enabled", true);
    settingService.setSetting("default_agent", "codex");
    settingService.deleteSetting("never_set_at_all");

    expect(named("setting.changed")).toEqual([]);
  });

  it("redacts a credential's value while still recording that it rotated", () => {
    reset();
    settingService.setSetting("some_api_token", "s3cr3t-value");
    const changed = named("setting.changed")[0];
    expect(changed).toMatchObject({ key: "some_api_token", to: "[redacted]" });
    expect(JSON.stringify(changed)).not.toContain("s3cr3t-value");
  });

  // The plan flagged the recall batch writer as a possible second path that
  // would be silent. It is not: it funnels through the same three writers, so
  // the choke point covers it without a second call site.
  it("covers the recall settings batch writer through the same choke point", () => {
    reset();
    recallSettings.writeRecallSettings({ enabled: true, recallEngineHarness: "codex" });
    const keys = named("setting.changed").map((e) => e.key);
    expect(keys).toContain("recall_enabled");
    expect(keys).toContain("recall_engine_harness");
  });
});

describe("event shape (R7)", () => {
  it("gives every event a name and keeps it on one forwarded line", () => {
    reset();
    const project = newProject();
    const task = newTask(project.id);
    settingService.setSetting("default_agent", "codex");
    taskService.deleteTask(task.id);

    const all = events();
    expect(all.length).toBeGreaterThan(0);
    for (const event of all) {
      expect(typeof event.event).toBe("string");
      expect(event.event.length).toBeGreaterThan(0);
    }
  });

  it("lets one session's activity be isolated from everything else", () => {
    const project = newProject("a");
    const other = newProject("b");
    const mine = newTask(project.id);
    const theirs = newTask(other.id);
    reset();

    taskService.archiveTask(mine.id);
    taskService.archiveTask(theirs.id);
    taskService.restoreTask(mine.id);

    const forOneSession = events().filter((e) => e.taskId === mine.id);
    expect(forOneSession.map((e) => e.event)).toEqual([
      "session.archived",
      "session.restored",
    ]);
  });

  it("emits nothing for reads", () => {
    // R13: an idle hour of looking at things produces no lines.
    const project = newProject();
    const task = newTask(project.id);
    reset();

    projectService.listProjects();
    projectService.getProject(project.id);
    taskService.listTasksForProject(project.id);
    taskService.getTask(task.id);
    groupService.listGroups();
    settingService.getSetting("default_agent");
    settingService.getBooleanSetting("recall_enabled");
    recallSettings.readRecallSettings();

    expect(events()).toEqual([]);
  });
});
