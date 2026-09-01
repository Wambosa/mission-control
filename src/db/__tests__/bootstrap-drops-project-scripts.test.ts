import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Custom scripts and the worktree setup command lose their surfaces, so their
// columns go. The upgrade path runs the migration first and ensureSchema
// second, and ensureSchema previously re-added custom_scripts through an
// ensureColumn guard — this proves that guard is gone with it.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-scripts-drop-test-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const SCRIPTS_DROP_MIGRATION = "0027_drop_project_scripts.sql";

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
    CREATE TABLE schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  d.prepare(
    `INSERT INTO projects (id, name, path, icon, icon_color, custom_scripts, worktree_setup_command, created_at, updated_at)
     VALUES ('p-scripts', 'Scripts', '/tmp/p-scripts', 'SC', '#fff', ?, 'pnpm i', 1, 1)`,
  ).run(JSON.stringify([{ id: "s1", name: "test", command: "pnpm test" }]));

  const mark = d.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, 1)");
  for (const name of fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql"))) {
    if (name === SCRIPTS_DROP_MIGRATION) continue;
    mark.run(name);
  }
  d.close();
}

seedPreMigrationDatabase(path.join(tmpRoot, "missioncontrol.db"));

const { getDb, getSqlite } = await import("~/db/client");

function projectColumns(): string[] {
  return (getSqlite().prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map(
    (c) => c.name,
  );
}

describe("project script column drop", () => {
  it("boots a populated database and removes both columns", () => {
    getDb();
    expect(projectColumns()).not.toContain("custom_scripts");
    expect(projectColumns()).not.toContain("worktree_setup_command");
  });

  it("does not let ensureSchema add custom_scripts back", () => {
    getDb();
    expect(projectColumns()).not.toContain("custom_scripts");
  });

  it("keeps the project rows the columns hung off", () => {
    getDb();
    const row = getSqlite()
      .prepare("SELECT id, name FROM projects WHERE id = 'p-scripts'")
      .get() as { id: string; name: string } | undefined;
    expect(row).toEqual({ id: "p-scripts", name: "Scripts" });
  });
});
