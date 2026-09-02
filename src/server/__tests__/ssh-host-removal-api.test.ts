import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-host-removal-test-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const { createProject, updateProject, getProject } = await import("../services/projects");
const { createTask, listTasksForProject } = await import("../services/tasks");
const { deleteSandbox } = await import("../services/sandboxes");
const { getDb, getSqlite } = await import("~/db/client");
const { projects, tasks, sandboxes, worktrees } = await import("~/db/schema");

function makeSandbox(id: string, kind: "ssh-host" | "remote-vm"): string {
  const now = Date.now();
  getSqlite()
    .prepare(
      `INSERT INTO sandboxes (id, name, kind, git_auth_mode, copy_agent_creds, created_at, updated_at)
       VALUES (?, ?, ?, 'none', 0, ?, ?)`,
    )
    .run(id, id, kind, now, now);
  return id;
}

let counter = 0;
function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mc-host-removal-p${++counter}-`));
  return createProject({ name: `p${counter}`, path: dir }).id;
}

describe("removing an SSH host", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(tasks).run();
    db.delete(worktrees).run();
    db.delete(projects).run();
    db.delete(sandboxes).run();
  });

  it("leaves the project in a stated state rather than deleting it", () => {
    const host = makeSandbox("sb-host", "ssh-host");
    const id = makeProject();
    updateProject(id, { sandboxId: host, remoteDirectory: "/home/deploy/acme" });

    expect(deleteSandbox(host)).toBe(true);

    const project = getProject(id);
    expect(project).not.toBeNull();
    // Falls back to Local with no dangling reference to a machine that is gone.
    expect(project?.sandboxId).toBeNull();
    expect(project?.remoteDirectory).toBeNull();
  });

  it("detaches every project that ran on the host, not just one", () => {
    const host = makeSandbox("sb-host", "ssh-host");
    const a = makeProject();
    const b = makeProject();
    updateProject(a, { sandboxId: host, remoteDirectory: "/srv/a" });
    updateProject(b, { sandboxId: host, remoteDirectory: "/srv/b" });

    deleteSandbox(host);

    expect(getProject(a)?.sandboxId).toBeNull();
    expect(getProject(b)?.sandboxId).toBeNull();
  });

  // The project survives, so the work done on it survives too. Deleting the
  // sessions here would keep the project and silently destroy its history —
  // the exact disappearance the scope-blind session list exists to prevent.
  it("keeps the sessions that ran on the host", () => {
    const host = makeSandbox("sb-host", "ssh-host");
    const id = makeProject();
    updateProject(id, { sandboxId: host, remoteDirectory: "/home/deploy/acme" });
    createTask({ projectId: id, title: "On the host", agent: "claude-code", scopeId: host });
    createTask({ projectId: id, title: "Local one", agent: "claude-code", scopeId: "local" });

    deleteSandbox(host);

    expect(
      listTasksForProject(id)
        .map((task: { title: string }) => task.title)
        .sort(),
    ).toEqual(["Local one", "On the host"]);
  });

  it("still takes a managed remote VM's project with it — the VM contains it", () => {
    const vm = makeSandbox("sb-vm", "remote-vm");
    const id = makeProject();
    updateProject(id, { sandboxId: vm });

    createTask({ projectId: id, title: "In the VM", agent: "claude-code", scopeId: vm });

    expect(deleteSandbox(vm)).toBe(true);
    // The project went with the machine that contained it, so its sessions
    // have nothing left to belong to.
    expect(getProject(id)).toBeNull();
    expect(getDb().select().from(tasks).all()).toEqual([]);
  });
});
