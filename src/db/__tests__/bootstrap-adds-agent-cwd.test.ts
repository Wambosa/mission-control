import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The directory a session's agent reports is a new task column. Both boot
// paths must converge on it: the migration adds it to an existing database,
// and the ensureColumn guard covers a schema-divergent build. Sessions that
// predate it stay null — the header falls back to their assigned worktree.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-agent-cwd-column-test-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const AGENT_CWD_MIGRATION = "0029_task_agent_cwd.sql";

function seedPreMigrationDatabase(dbPath: string): void {
  const d = new Database(dbPath);
  d.exec(`
    CREATE TABLE groups (id TEXT PRIMARY KEY);
    CREATE TABLE sandboxes (id TEXT PRIMARY KEY);
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      icon TEXT NOT NULL,
      icon_color TEXT NOT NULL,
      image_path TEXT,
      group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
      sandbox_id TEXT REFERENCES sandboxes(id) ON DELETE CASCADE,
      pinned INTEGER NOT NULL DEFAULT 0,
      pinned_order INTEGER,
      branch TEXT NOT NULL DEFAULT 'main',
      remote_directory TEXT,
      remember_agent_settings INTEGER NOT NULL DEFAULT 0,
      saved_agent TEXT,
      saved_skip_permissions INTEGER NOT NULL DEFAULT 0,
      saved_bare_session INTEGER NOT NULL DEFAULT 0,
      default_grid_view INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      worktree_id TEXT REFERENCES worktrees(id) ON DELETE CASCADE,
      scope_id TEXT NOT NULL DEFAULT 'local',
      title TEXT NOT NULL,
      title_manually_set INTEGER NOT NULL DEFAULT 0,
      icon TEXT,
      agent TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      branch TEXT NOT NULL DEFAULT 'main',
      preview TEXT NOT NULL DEFAULT '',
      lines INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      pinned INTEGER NOT NULL DEFAULT 0,
      claude_session_id TEXT,
      claude_skip_permissions INTEGER NOT NULL DEFAULT 0,
      claude_bare_session INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  d.prepare(
    `INSERT INTO projects (id, name, path, icon, icon_color, created_at, updated_at)
     VALUES ('p-legacy', 'Legacy', '/tmp/p-legacy', 'LE', '#fff', 1, 1)`,
  ).run();
  d.prepare(
    `INSERT INTO tasks (id, project_id, title, agent, created_at, updated_at)
     VALUES ('t-legacy', 'p-legacy', 'Older session', 'claude-code', 1, 1)`,
  ).run();

  const mark = d.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, 1)");
  for (const name of fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql"))) {
    if (name === AGENT_CWD_MIGRATION) continue;
    mark.run(name);
  }
  d.close();
}

seedPreMigrationDatabase(path.join(tmpRoot, "missioncontrol.db"));

const { getDb, getSqlite } = await import("~/db/client");

describe("task agent_cwd column", () => {
  it("is added to an existing database on boot", () => {
    getDb();
    const columns = (
      getSqlite().prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toContain("agent_cwd");
  });

  it("leaves sessions recorded before it null", () => {
    getDb();
    const row = getSqlite()
      .prepare("SELECT agent_cwd FROM tasks WHERE id = 't-legacy'")
      .get() as { agent_cwd: string | null };
    expect(row.agent_cwd).toBeNull();
  });
});
