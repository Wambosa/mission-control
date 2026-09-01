import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The launch runner's two project columns are dropped by a hand-authored
// migration. This exercises the upgrade path the app actually takes on boot:
// runMigrations() first, then ensureSchema(). Both halves matter — dropping the
// columns while ensureSchema still declared them would recreate them on the
// next fresh install, and the stored project rows must survive the drop.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-launch-drop-test-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "migrations");
const LAUNCH_DROP_MIGRATION = "0025_drop_project_launch.sql";

// A projects table exactly as it stood before this migration, so the ALTER has
// something real to drop.
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
      launch_commands TEXT,
      custom_scripts TEXT,
      launch_url TEXT,
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
    `INSERT INTO projects (id, name, path, icon, icon_color, launch_commands, launch_url, created_at, updated_at)
     VALUES ('p-legacy', 'Legacy', '/tmp/p-legacy', 'LE', '#fff', ?, 'http://localhost:5173', 1, 1)`,
  ).run(JSON.stringify([{ id: "c1", name: "dev", command: "pnpm dev" }]));

  // Everything before this migration is already applied; only the drop is new.
  const mark = d.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, 1)");
  for (const name of fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql"))) {
    if (name === LAUNCH_DROP_MIGRATION) continue;
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

describe("launch column drop", () => {
  it("boots a populated database and removes both launch columns", () => {
    getDb();
    expect(projectColumns()).not.toContain("launch_commands");
    expect(projectColumns()).not.toContain("launch_url");
  });

  it("keeps the project rows the columns hung off", () => {
    getDb();
    const row = getSqlite()
      .prepare("SELECT id, name, path FROM projects WHERE id = 'p-legacy'")
      .get() as { id: string; name: string; path: string } | undefined;
    expect(row).toEqual({ id: "p-legacy", name: "Legacy", path: "/tmp/p-legacy" });
  });

  it("does not let ensureSchema recreate them on the next boot", () => {
    getDb();
    // ensureSchema runs on every boot; a stale CREATE TABLE / ensureColumn
    // would put the columns straight back.
    expect(projectColumns()).not.toContain("launch_commands");
    expect(projectColumns()).not.toContain("launch_url");
  });
});
