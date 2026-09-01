import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-remote-dir-test-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const { handleApiRequest } = await import("../api-router");
const { getOrCreateApiToken } = await import("../services/settings");
const { createProject } = await import("../services/projects");
const { getDb, getSqlite } = await import("~/db/client");
const { projects, tasks, sandboxes, worktrees } = await import("~/db/schema");

function authed(input: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${getOrCreateApiToken()}`);
  if (init.body) headers.set("content-type", "application/json");
  return new Request(`http://localhost${input}`, { ...init, headers });
}

async function patch(id: string, body: Record<string, unknown>) {
  return handleApiRequest(
    authed(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  );
}

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mc-remote-dir-p${++counter}-`));
  return createProject({ name: `p${counter}`, path: dir }).id;
}

describe("project remote directory", () => {
  beforeEach(() => {
    const db = getDb();
    db.delete(tasks).run();
    db.delete(worktrees).run();
    db.delete(projects).run();
    db.delete(sandboxes).run();
  });

  it("starts null — the old derivation is not replayed onto existing projects", async () => {
    const id = makeProject();
    const res = await handleApiRequest(authed(`/api/projects/${id}`));
    const body = (await res!.json()) as { project: { remoteDirectory: string | null } };
    expect(body.project.remoteDirectory).toBeNull();
  });

  it("persists a host and its directory in one update", async () => {
    const id = makeProject();
    const host = makeSandbox("sb-host", "ssh-host");

    const res = await patch(id, { sandboxId: host, remoteDirectory: "/home/deploy/acme" });
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as {
      project: { sandboxId: string | null; remoteDirectory: string | null };
    };
    expect(body.project).toMatchObject({ sandboxId: host, remoteDirectory: "/home/deploy/acme" });
  });

  it("keeps a directory that differs from the local folder's name", async () => {
    const id = makeProject();
    const host = makeSandbox("sb-host", "ssh-host");
    await patch(id, { sandboxId: host, remoteDirectory: "/srv/Totally_Different" });
    const res = await handleApiRequest(authed(`/api/projects/${id}`));
    const body = (await res!.json()) as { project: { remoteDirectory: string | null } };
    expect(body.project.remoteDirectory).toBe("/srv/Totally_Different");
  });

  it("accepts a directory that does not exist on the host yet", async () => {
    const id = makeProject();
    const host = makeSandbox("sb-host", "ssh-host");
    const res = await patch(id, {
      sandboxId: host,
      remoteDirectory: "/home/deploy/not-created-yet",
    });
    expect(res?.status).toBe(200);
  });

  it("rejects a host-scoped project with no directory", async () => {
    const id = makeProject();
    const host = makeSandbox("sb-host", "ssh-host");
    const res = await patch(id, { sandboxId: host, remoteDirectory: "" });
    expect(res?.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toMatch(/remote directory/i);
  });

  it("leaves a Local project's directory alone", async () => {
    const id = makeProject();
    const res = await patch(id, { sandboxId: null, remoteDirectory: null });
    expect(res?.status).toBe(200);
    const body = (await res!.json()) as { project: { remoteDirectory: string | null } };
    expect(body.project.remoteDirectory).toBeNull();
  });

  it("does not demand a directory from a managed remote VM, which derives its own", async () => {
    const id = makeProject();
    const vm = makeSandbox("sb-vm", "remote-vm");
    const res = await patch(id, { sandboxId: vm });
    expect(res?.status).toBe(200);
  });
});
