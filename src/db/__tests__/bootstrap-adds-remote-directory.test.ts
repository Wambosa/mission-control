import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// A project's directory on its SSH host is a new column. Both boot paths must
// converge on it: the migration adds it to an existing database, and the
// ensureColumn guard covers a schema-divergent build. Existing rows stay null —
// the old derivation cannot be reproduced in SQL.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-remote-dir-column-test-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const REMOTE_DIR_MIGRATION = "0028_project_remote_directory.sql";

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
      remember_agent_settings INTEGER NOT NULL DEFAULT 0,
      saved_agent TEXT,
      saved_skip_permissions INTEGER NOT NULL DEFAULT 0,
      saved_bare_session INTEGER NOT NULL DEFAULT 0,
      default_grid_view INTEGER NOT NULL DEFAULT 0,
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
     VALUES ('p-legacy', 'Legacy', '/Users/me/code/Acme App', 'LE', '#fff', 1, 1)`,
  ).run();

  const mark = d.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, 1)");
  for (const name of fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql"))) {
    if (name === REMOTE_DIR_MIGRATION) continue;
    mark.run(name);
  }
  d.close();
}

seedPreMigrationDatabase(path.join(tmpRoot, "missioncontrol.db"));

const { getDb, getSqlite } = await import("~/db/client");

describe("project remote_directory column", () => {
  it("is added to an existing database on boot", () => {
    getDb();
    const columns = (
      getSqlite().prepare("PRAGMA table_info(projects)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toContain("remote_directory");
  });

  it("leaves existing projects null rather than replaying the old derivation", () => {
    getDb();
    const row = getSqlite()
      .prepare("SELECT remote_directory FROM projects WHERE id = 'p-legacy'")
      .get() as { remote_directory: string | null };
    expect(row.remote_directory).toBeNull();
  });
});
