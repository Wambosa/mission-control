import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Scratch pads leave the product, so their table leaves the database. Both
// halves of the boot matter here: the migration removes the table, and
// ensureSchema must no longer declare it — otherwise the very boot that ran the
// migration would put the table straight back.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-scratch-drop-test-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const SCRATCH_DROP_MIGRATION = "0026_drop_scratch_pads.sql";

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
      custom_scripts TEXT,
      worktree_setup_command TEXT,
      remember_agent_settings INTEGER NOT NULL DEFAULT 0,
      saved_agent TEXT,
      saved_skip_permissions INTEGER NOT NULL DEFAULT 0,
      saved_bare_session INTEGER NOT NULL DEFAULT 0,
      default_grid_view INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE scratch_pads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX scratch_pads_project_idx ON scratch_pads(project_id);
    CREATE INDEX scratch_pads_project_updated_idx ON scratch_pads(project_id, updated_at);
    CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  d.prepare(
    `INSERT INTO projects (id, name, path, icon, icon_color, created_at, updated_at)
     VALUES ('p-pads', 'Pads', '/tmp/p-pads', 'PA', '#fff', 1, 1)`,
  ).run();
  d.prepare(
    `INSERT INTO scratch_pads (id, project_id, content, created_at, updated_at)
     VALUES ('pad-1', 'p-pads', 'a pad with content in it', 1, 1)`,
  ).run();

  const mark = d.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, 1)");
  for (const name of fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql"))) {
    if (name === SCRATCH_DROP_MIGRATION) continue;
    mark.run(name);
  }
  d.close();
}

seedPreMigrationDatabase(path.join(tmpRoot, "missioncontrol.db"));

const { getDb, getSqlite } = await import("~/db/client");

function tableNames(): string[] {
  return (
    getSqlite()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
  ).map((t) => t.name);
}

describe("scratch pad table drop", () => {
  it("boots a database holding pads and drops the table", () => {
    getDb();
    expect(tableNames()).not.toContain("scratch_pads");
  });

  it("does not recreate the table on the boot that dropped it", () => {
    getDb();
    // ensureSchema runs after the migration on an existing database; a stale
    // CREATE TABLE IF NOT EXISTS there would resurrect it immediately.
    expect(tableNames()).not.toContain("scratch_pads");
  });

  it("leaves the project the pads hung off alone", () => {
    getDb();
    const row = getSqlite()
      .prepare("SELECT id, name FROM projects WHERE id = 'p-pads'")
      .get() as { id: string; name: string } | undefined;
    expect(row).toEqual({ id: "p-pads", name: "Pads" });
  });
});
