import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { disposeSandboxStore, listSandboxConfigs, readSandboxConfig } from "../sandbox-store";
import {
  DEFAULT_SSH_IDLE_WINDOW_MINUTES,
  type SandboxRemoteConfig,
} from "../../src/shared/sandbox";

// Reads go through the same `sandboxes` table the server owns, so the fixture
// mirrors the DDL in src/db/client.ts rather than importing Drizzle.
const SANDBOXES_DDL = `
  CREATE TABLE IF NOT EXISTS sandboxes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'remote-vm',
    color TEXT,
    image_tag TEXT,
    dockerfile_path TEXT,
    build_args TEXT,
    git_auth_mode TEXT NOT NULL DEFAULT 'none',
    copy_agent_creds INTEGER NOT NULL DEFAULT 0,
    declared_ports TEXT,
    env TEXT,
    host_agent_port INTEGER,
    port_map TEXT,
    pairing_token TEXT,
    remote_config TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

describe("sandbox-store", () => {
  let userDataDir = "";

  afterEach(() => {
    disposeSandboxStore();
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    userDataDir = "";
  });

  function seed(rows: Array<{ id: string; kind: string; remote: SandboxRemoteConfig | null }>): string {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-sandbox-store-"));
    const db = new Database(path.join(userDataDir, "missioncontrol.db"));
    db.exec(SANDBOXES_DDL);
    const insert = db.prepare(
      "INSERT INTO sandboxes (id, name, kind, remote_config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(row.id, row.id, row.kind, row.remote ? JSON.stringify(row.remote) : null, 1, 1);
    }
    db.close();
    return userDataDir;
  }

  it("round-trips an SSH host record with its alias, prefix, persistence, and idle window", () => {
    const dir = seed([
      {
        id: "sb-ssh",
        kind: "ssh-host",
        remote: {
          agentUrl: "ws://127.0.0.1:54321",
          ssh: {
            alias: "workshop",
            prefix: "/home/sam/.mission-control",
            platform: "linux",
            onDisconnect: "teardown",
            idleWindowMinutes: 5,
            agentPort: null,
            workspaceRoot: null,
          },
        },
      },
    ]);

    const config = readSandboxConfig(dir, "sb-ssh");
    expect(config?.kind).toBe("ssh-host");
    expect(config?.remoteAgentUrl).toBe("ws://127.0.0.1:54321/");
    expect(config?.sshHost).toEqual({
      alias: "workshop",
      prefix: "/home/sam/.mission-control",
      platform: "linux",
      onDisconnect: "teardown",
      idleWindowMinutes: 5,
      agentPort: null,
      workspaceRoot: null,
    });
  });

  it("reads an SSH host row missing the newer fields with defaults", () => {
    const dir = seed([
      {
        id: "sb-ssh",
        kind: "ssh-host",
        remote: { agentUrl: "ws://127.0.0.1:54321", ssh: { alias: "workshop" } as never },
      },
    ]);

    expect(readSandboxConfig(dir, "sb-ssh")?.sshHost).toEqual({
      alias: "workshop",
      prefix: null,
      platform: null,
      onDisconnect: "persist",
      idleWindowMinutes: DEFAULT_SSH_IDLE_WINDOW_MINUTES,
      agentPort: null,
      workspaceRoot: null,
    });
  });

  it("keeps remote VM rows unchanged and carries no SSH host record", () => {
    const dir = seed([
      {
        id: "sb-vm",
        kind: "remote-vm",
        remote: { agentUrl: "https://vm.example.com", provider: "aws", status: "ready" },
      },
    ]);

    const config = readSandboxConfig(dir, "sb-vm");
    expect(config?.kind).toBe("remote-vm");
    expect(config?.remoteAgentUrl).toBe("wss://vm.example.com/");
    expect(config?.remoteProvider).toBe("aws");
    expect(config?.sshHost).toBeNull();
  });

  it("lists both kinds and falls back to remote-vm for a kind this build doesn't know", () => {
    const dir = seed([
      { id: "sb-vm", kind: "remote-vm", remote: { agentUrl: "wss://vm.example.com" } },
      {
        id: "sb-ssh",
        kind: "ssh-host",
        remote: { agentUrl: "ws://127.0.0.1:54321", ssh: { alias: "workshop" } as never },
      },
      { id: "sb-future", kind: "warp-drive", remote: null },
    ]);

    expect(
      Object.fromEntries(listSandboxConfigs(dir).map((c) => [c.id, c.kind])),
    ).toEqual({ "sb-vm": "remote-vm", "sb-ssh": "ssh-host", "sb-future": "remote-vm" });
  });
});
