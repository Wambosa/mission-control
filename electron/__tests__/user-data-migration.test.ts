import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runUserDataMigration } from "../user-data-migration";
import { acquirePreviousInstanceLock } from "../previous-instance";
import { USER_DATA_DB_FILENAME } from "../../src/shared/user-data-paths";
import {
  MIGRATION_IDENTITY_SETTING_KEY,
  MIGRATION_MARKER_FILENAME,
  MIGRATION_MARKER_VERSION,
  type MigrationMarker,
} from "../../src/shared/user-data-migration";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) {
    try {
      undo();
    } catch {
      /* best effort */
    }
  }
});

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-data-migration-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const APP_VERSION = "1.0.0";

/** A previous-identity directory carrying real app state, WAL and all. */
function seedPrevious(options: { uncleanWal?: boolean; extras?: string[] } = {}): {
  previousDir: string;
  destinationDir: string;
  dbPath: string;
} {
  const root = tmpRoot();
  const previousDir = path.join(root, "MissionControl");
  const destinationDir = path.join(root, "ChaosWrangler");
  fs.mkdirSync(previousDir, { recursive: true });

  const dbPath = path.join(previousDir, USER_DATA_DB_FILENAME);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE sandboxes (id TEXT PRIMARY KEY, pairing_token TEXT);
    CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO app_settings VALUES (?, ?)").run("api_token", "bearer-secret-value");
  db.prepare("INSERT INTO projects VALUES (?, ?)").run("p1", "Mission Control");
  db.prepare("INSERT INTO projects VALUES (?, ?)").run("p2", "Another");
  db.prepare("INSERT INTO sandboxes VALUES (?, ?)").run("sb1", "pairing-secret-1");
  db.prepare("INSERT INTO sandboxes VALUES (?, ?)").run("sb2", "pairing-secret-2");
  db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run("0001_init.sql", 1);
  db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run("0002_more.sql", 2);

  if (options.uncleanWal) {
    // Leave committed transactions sitting in the write-ahead log, the way an
    // uncleanly closed writer does. Copying the database alone loses these.
    //
    // Closing the last connection checkpoints and removes the log, so the
    // non-empty pair is snapshotted while the writer is still open and put
    // back afterwards. That leaves the on-disk state a dead writer leaves —
    // a populated log with nobody holding it.
    db.pragma("wal_autocheckpoint = 0");
    for (let i = 0; i < 200; i++) {
      db.prepare("INSERT INTO projects VALUES (?, ?)").run(`bulk-${i}`, `Project ${i}`);
    }
    const holdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "unclean-wal-"));
    cleanup.push(() => fs.rmSync(holdRoot, { recursive: true, force: true }));
    const heldDb = path.join(holdRoot, "db");
    const heldWal = path.join(holdRoot, "wal");
    fs.copyFileSync(dbPath, heldDb);
    fs.copyFileSync(`${dbPath}-wal`, heldWal);
    db.close();
    fs.copyFileSync(heldDb, dbPath);
    fs.copyFileSync(heldWal, `${dbPath}-wal`);
    fs.rmSync(`${dbPath}-shm`, { force: true });
  } else {
    db.close();
  }

  for (const extra of options.extras ?? []) {
    const target = path.join(previousDir, extra);
    if (extra.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "content.txt"), "kept");
    } else {
      fs.writeFileSync(target, `content of ${extra}`);
    }
  }

  return { previousDir, destinationDir, dbPath };
}

function run(input: {
  previousDir: string;
  destinationDir: string;
  override?: string | null;
}): ReturnType<typeof runUserDataMigration> {
  return runUserDataMigration({
    previousDir: input.previousDir,
    destinationDir: input.destinationDir,
    override: input.override ?? null,
    appVersion: APP_VERSION,
  });
}

function readMarker(destinationDir: string): MigrationMarker {
  const raw = fs.readFileSync(path.join(destinationDir, MIGRATION_MARKER_FILENAME), "utf8");
  return JSON.parse(raw) as MigrationMarker;
}

function openReadOnly(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  cleanup.push(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });
  return db;
}

function rowCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("runUserDataMigration — the happy path (AE1)", () => {
  it("carries the data forward and leaves the previous copy readable", () => {
    const { previousDir, destinationDir } = seedPrevious();

    const report = run({ previousDir, destinationDir });

    expect(report.outcome).toBe("migrated");
    expect(report.directory).toBe(destinationDir);
    expect(report.refusal).toBeNull();

    const copied = openReadOnly(path.join(destinationDir, USER_DATA_DB_FILENAME));
    expect(rowCount(copied, "projects")).toBe(2);
    expect(
      (
        copied.prepare("SELECT value FROM app_settings WHERE key = 'api_token'").get() as {
          value: string;
        }
      ).value,
    ).toBe("bearer-secret-value");

    // The previous database still returns the same rows.
    const previous = openReadOnly(path.join(previousDir, USER_DATA_DB_FILENAME));
    expect(rowCount(previous, "projects")).toBe(2);
    expect(
      (
        previous.prepare("SELECT value FROM app_settings WHERE key = 'api_token'").get() as {
          value: string;
        }
      ).value,
    ).toBe("bearer-secret-value");
  });

  it("writes the marker last, recording the outcome and the identity", () => {
    const { previousDir, destinationDir } = seedPrevious();

    run({ previousDir, destinationDir });
    const marker = readMarker(destinationDir);

    expect(marker.markerVersion).toBe(MIGRATION_MARKER_VERSION);
    expect(marker.appVersion).toBe(APP_VERSION);
    expect(marker.outcome).toBe("migrated");
    expect(marker.sourcePath).toBe(previousDir);
    expect(marker.identity).toBeTruthy();
    expect(marker.divergenceBaseline).not.toBeNull();

    const copied = openReadOnly(path.join(destinationDir, USER_DATA_DB_FILENAME));
    const stored = copied
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(MIGRATION_IDENTITY_SETTING_KEY) as { value: string };
    expect(stored.value).toBe(marker.identity);
  });

  it("records the fingerprint but keeps no credential values in it", () => {
    const { previousDir, destinationDir } = seedPrevious();

    run({ previousDir, destinationDir });
    const marker = readMarker(destinationDir);
    const serialized = JSON.stringify(marker);

    expect(marker.fingerprint).not.toBeNull();
    expect(marker.fingerprint!.source.rowCounts.projects).toBe(2);
    expect(serialized).not.toContain("bearer-secret-value");
    expect(serialized).not.toContain("pairing-secret-1");
  });

  it("copies committed transactions still sitting in the write-ahead log (AE9)", () => {
    const { previousDir, destinationDir } = seedPrevious({ uncleanWal: true });

    const report = run({ previousDir, destinationDir });

    expect(report.outcome).toBe("migrated");
    const copied = openReadOnly(path.join(destinationDir, USER_DATA_DB_FILENAME));
    expect(rowCount(copied, "projects")).toBe(202);
    expect(rowCount(copied, "sandboxes")).toBe(2);

    // Credentials are byte-identical, not merely present.
    const tokens = copied
      .prepare("SELECT id, pairing_token FROM sandboxes ORDER BY id")
      .all() as Array<{ id: string; pairing_token: string }>;
    expect(tokens).toEqual([
      { id: "sb1", pairing_token: "pairing-secret-1" },
      { id: "sb2", pairing_token: "pairing-secret-2" },
    ]);

    // The applied-migration list matches.
    const applied = copied
      .prepare("SELECT name FROM schema_migrations ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(applied.map((r) => r.name)).toEqual(["0001_init.sql", "0002_more.sql"]);
  });

  it("copies the allowlist and nothing else", () => {
    const { previousDir, destinationDir } = seedPrevious({
      extras: [".port", ".window-bg", "project-images/", "directory-grants.json", "Cookies"],
    });
    fs.mkdirSync(path.join(previousDir, "Cache"), { recursive: true });
    fs.writeFileSync(path.join(previousDir, "Cache", "big.bin"), "x".repeat(1024));

    run({ previousDir, destinationDir });

    const landed = fs.readdirSync(destinationDir).sort();
    expect(landed).toContain(USER_DATA_DB_FILENAME);
    expect(landed).toContain(".port");
    expect(landed).toContain(".window-bg");
    expect(landed).toContain("project-images");
    expect(landed).toContain(MIGRATION_MARKER_FILENAME);

    // Excluded: the grants file, the browser engine's caches and cookies.
    expect(landed).not.toContain("directory-grants.json");
    expect(landed).not.toContain("Cookies");
    expect(landed).not.toContain("Cache");
    // And no temporaries survive.
    expect(landed.filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves the destination and its database owner-only, even when the directory pre-existed world-readable", () => {
    const { previousDir, destinationDir } = seedPrevious();
    fs.mkdirSync(destinationDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(destinationDir, 0o755);

    run({ previousDir, destinationDir });

    expect(fs.statSync(destinationDir).mode & 0o777).toBe(0o700);
    const dbPath = path.join(destinationDir, USER_DATA_DB_FILENAME);
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
    for (const sidecar of [`${dbPath}-wal`]) {
      if (fs.existsSync(sidecar)) expect(fs.statSync(sidecar).mode & 0o777).toBe(0o600);
    }
  });

  it("does not copy the shared-memory sidecar", () => {
    const { previousDir, destinationDir } = seedPrevious({ uncleanWal: true });
    run({ previousDir, destinationDir });
    expect(fs.existsSync(path.join(destinationDir, `${USER_DATA_DB_FILENAME}-shm`))).toBe(false);
  });
});

describe("runUserDataMigration — idempotence (AE2)", () => {
  it("makes no changes on a launch after a completed migration", () => {
    const { previousDir, destinationDir } = seedPrevious();
    run({ previousDir, destinationDir });
    const firstMarker = readMarker(destinationDir);

    // The user has since done work under the new identity.
    const dbPath = path.join(destinationDir, USER_DATA_DB_FILENAME);
    const live = new Database(dbPath);
    live.prepare("INSERT INTO projects VALUES (?, ?)").run("p3", "Created after migrating");
    live.close();

    const second = run({ previousDir, destinationDir });

    expect(second.outcome).toBe("already-migrated");
    expect(second.directory).toBe(destinationDir);
    expect(second.refusal).toBeNull();
    // The row count moved and the marker still validates: the launch-time check
    // must not be comparing row counts.
    const after = openReadOnly(dbPath);
    expect(rowCount(after, "projects")).toBe(3);
    expect(readMarker(destinationDir).identity).toBe(firstMarker.identity);
  });

  it("re-runs cleanly when a prior run copied files but wrote no marker", () => {
    const { previousDir, destinationDir } = seedPrevious();
    // A crash between the copy and the marker write leaves this state. It is a
    // destination carrying a database with no marker, which is a conflict.
    fs.mkdirSync(destinationDir, { recursive: true });
    fs.copyFileSync(
      path.join(previousDir, USER_DATA_DB_FILENAME),
      path.join(destinationDir, USER_DATA_DB_FILENAME),
    );

    const report = run({ previousDir, destinationDir });

    expect(report.outcome).toBe("destination-conflict");
  });

  it("runs when the destination holds only browser-engine scaffolding (AE8)", () => {
    const { previousDir, destinationDir } = seedPrevious();
    fs.mkdirSync(path.join(destinationDir, "GPUCache"), { recursive: true });
    fs.writeFileSync(path.join(destinationDir, "Local State"), "{}");

    const report = run({ previousDir, destinationDir });

    expect(report.outcome).toBe("migrated");
    expect(fs.existsSync(path.join(destinationDir, USER_DATA_DB_FILENAME))).toBe(true);
  });
});

describe("runUserDataMigration — the override (AE7)", () => {
  it("returns the override outcome, writes no marker, and never reads the source", () => {
    const { previousDir, destinationDir } = seedPrevious();
    const override = path.join(tmpRoot(), "override-dir");

    const report = run({ previousDir, destinationDir, override });

    expect(report.outcome).toBe("override");
    expect(report.directory).toBe(override);
    expect(fs.existsSync(path.join(destinationDir, MIGRATION_MARKER_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(destinationDir, USER_DATA_DB_FILENAME))).toBe(false);
  });
});

describe("runUserDataMigration — a fresh install (AE22)", () => {
  it("writes a marker recording that there was no previous directory", () => {
    const root = tmpRoot();
    const previousDir = path.join(root, "MissionControl");
    const destinationDir = path.join(root, "ChaosWrangler");

    const report = run({ previousDir, destinationDir });

    expect(report.outcome).toBe("no-previous-directory");
    expect(report.directory).toBe(destinationDir);
    expect(readMarker(destinationDir).outcome).toBe("no-previous-directory");
    // No database is manufactured — the app creates its own on first connection.
    expect(fs.existsSync(path.join(destinationDir, USER_DATA_DB_FILENAME))).toBe(false);
  });

  it("stays settled on the next launch", () => {
    const root = tmpRoot();
    const previousDir = path.join(root, "MissionControl");
    const destinationDir = path.join(root, "ChaosWrangler");

    run({ previousDir, destinationDir });
    const second = run({ previousDir, destinationDir });

    expect(second.outcome).toBe("already-migrated");
    expect(second.refusal).toBeNull();
  });
});

describe("runUserDataMigration — a running previous instance (AE19)", () => {
  it("abandons before copying anything and writes no marker", () => {
    const { previousDir, destinationDir, dbPath } = seedPrevious();
    const holder = new Database(dbPath);
    holder.pragma("journal_mode = WAL");
    holder.exec("BEGIN IMMEDIATE");
    cleanup.push(() => {
      try {
        holder.close();
      } catch {
        /* already closed */
      }
    });

    const report = run({ previousDir, destinationDir });

    expect(report.refusal).toBeTruthy();
    expect(report.refusal).toContain(previousDir);
    expect(fs.existsSync(path.join(destinationDir, USER_DATA_DB_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(destinationDir, MIGRATION_MARKER_FILENAME))).toBe(false);
  });
});

describe("runUserDataMigration — a destination conflict (AE17)", () => {
  it("reports a conflict, copies nothing, deletes nothing, and falls back", () => {
    const { previousDir, destinationDir } = seedPrevious();
    fs.mkdirSync(destinationDir, { recursive: true });
    const strangerPath = path.join(destinationDir, USER_DATA_DB_FILENAME);
    const stranger = new Database(strangerPath);
    stranger.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    stranger.prepare("INSERT INTO projects VALUES (?, ?)").run("other", "Not from the source");
    stranger.close();

    const report = run({ previousDir, destinationDir });

    expect(report.outcome).toBe("destination-conflict");
    expect(report.directory).toBe(previousDir);
    expect(report.refusal).toBeNull();
    expect(fs.existsSync(path.join(destinationDir, MIGRATION_MARKER_FILENAME))).toBe(false);

    // Not overwritten and not deleted.
    const survivor = openReadOnly(strangerPath);
    expect(
      (survivor.prepare("SELECT name FROM projects").get() as { name: string }).name,
    ).toBe("Not from the source");
  });
});

describe("runUserDataMigration — failure paths", () => {
  it("creates no database at the destination when the source is unreadable (AE3)", () => {
    const { previousDir, destinationDir, dbPath } = seedPrevious();
    fs.chmodSync(dbPath, 0o000);
    cleanup.push(() => fs.chmodSync(dbPath, 0o600));

    const report = run({ previousDir, destinationDir });

    expect(report.outcome).toBe("failed");
    expect(fs.existsSync(path.join(destinationDir, USER_DATA_DB_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(destinationDir, MIGRATION_MARKER_FILENAME))).toBe(false);
  });

  it("falls back to the previous directory and says so (AE10)", () => {
    const { previousDir, destinationDir, dbPath } = seedPrevious();
    fs.chmodSync(dbPath, 0o000);
    cleanup.push(() => fs.chmodSync(dbPath, 0o600));

    const report = run({ previousDir, destinationDir });

    expect(report.directory).toBe(previousDir);
    expect(report.refusal).toBeNull();
    expect(report.detail).toBeTruthy();
  });

  it("refuses to start when the previous directory cannot be opened either (AE24)", () => {
    const root = tmpRoot();
    const previousDir = path.join(root, "MissionControl");
    const destinationDir = path.join(root, "ChaosWrangler");
    fs.mkdirSync(previousDir, { recursive: true });
    fs.chmodSync(previousDir, 0o000);
    cleanup.push(() => fs.chmodSync(previousDir, 0o700));

    const report = run({ previousDir, destinationDir });

    expect(report.refusal).toBeTruthy();
    expect(report.refusal).toContain(previousDir);
    expect(report.refusal).toContain(destinationDir);
    expect(report.refusal).toContain("MC_USER_DATA_DIR");
  });

  it("removes partial artifacts so a retry is not poisoned", () => {
    const { previousDir, destinationDir, dbPath } = seedPrevious();
    fs.chmodSync(dbPath, 0o000);
    cleanup.push(() => fs.chmodSync(dbPath, 0o600));

    run({ previousDir, destinationDir });

    if (fs.existsSync(destinationDir)) {
      expect(fs.readdirSync(destinationDir).filter((n) => n.includes(".tmp"))).toEqual([]);
      expect(fs.existsSync(path.join(destinationDir, USER_DATA_DB_FILENAME))).toBe(false);
    }

    // With the source readable again, the retry succeeds.
    fs.chmodSync(dbPath, 0o600);
    const retry = run({ previousDir, destinationDir });
    expect(retry.outcome).toBe("migrated");
  });

  it("replaces a non-database file sitting at the destination database path", () => {
    const { previousDir, destinationDir } = seedPrevious();
    fs.mkdirSync(destinationDir, { recursive: true });
    fs.writeFileSync(path.join(destinationDir, USER_DATA_DB_FILENAME), "not a database at all");

    const report = run({ previousDir, destinationDir });

    // It is not a readable database, so it is not a conflict to preserve — the
    // migration proceeds and the retry is not poisoned by it.
    expect(report.outcome).toBe("migrated");
    const copied = openReadOnly(path.join(destinationDir, USER_DATA_DB_FILENAME));
    expect(rowCount(copied, "projects")).toBe(2);
  });

  it("fails rather than writing through a pre-existing temporary path", () => {
    const { previousDir, destinationDir } = seedPrevious();
    fs.mkdirSync(destinationDir, { recursive: true });

    // Someone else's file is already sitting where the copy would stage. Writing
    // through it would destroy data the migration does not own.
    const collision = path.join(destinationDir, `${USER_DATA_DB_FILENAME}.fixed.tmp`);
    fs.writeFileSync(collision, "someone else's file");

    const report = runUserDataMigration({
      previousDir,
      destinationDir,
      override: null,
      appVersion: APP_VERSION,
      temporarySuffix: () => "fixed",
    });

    expect(report.outcome).toBe("failed");
    expect(report.directory).toBe(previousDir);
    expect(fs.readFileSync(collision, "utf8")).toBe("someone else's file");
    expect(fs.existsSync(path.join(destinationDir, USER_DATA_DB_FILENAME))).toBe(false);
    expect(fs.existsSync(path.join(destinationDir, MIGRATION_MARKER_FILENAME))).toBe(false);
  });
});

describe("runUserDataMigration — optional files", () => {
  it("does not fail the migration when an optional file cannot be copied", () => {
    const { previousDir, destinationDir } = seedPrevious({ extras: [".port"] });
    const portFile = path.join(previousDir, ".port");
    fs.chmodSync(portFile, 0o000);
    cleanup.push(() => fs.chmodSync(portFile, 0o600));

    const report = run({ previousDir, destinationDir });

    expect(["migrated", "migrated-with-skipped"]).toContain(report.outcome);
    expect(fs.existsSync(path.join(destinationDir, USER_DATA_DB_FILENAME))).toBe(true);
    if (report.outcome === "migrated-with-skipped") {
      expect(report.skipped).toContain(".port");
      expect(readMarker(destinationDir).skipped).toContain(".port");
    }
  });
});

describe("runUserDataMigration — divergence (AE21)", () => {
  it("reports work in the previous directory once, then stays quiet", () => {
    const { previousDir, destinationDir, dbPath } = seedPrevious();
    run({ previousDir, destinationDir });

    // The previous application is launched again and its writes land in the
    // write-ahead log, leaving the database file itself untouched.
    const previousApp = new Database(dbPath);
    previousApp.pragma("journal_mode = WAL");
    previousApp.pragma("wal_autocheckpoint = 0");
    previousApp.prepare("INSERT INTO projects VALUES (?, ?)").run("later", "Made in the old app");
    previousApp.close();

    const first = run({ previousDir, destinationDir });
    expect(first.divergence).toBe(true);
    expect(first.outcome).toBe("already-migrated");

    const second = run({ previousDir, destinationDir });
    expect(second.divergence).toBe(false);
  });

  it("reports nothing when the previous store has not been touched", () => {
    const { previousDir, destinationDir } = seedPrevious();
    run({ previousDir, destinationDir });

    const second = run({ previousDir, destinationDir });
    expect(second.divergence).toBe(false);
  });
});

describe("runUserDataMigration — the lock is held across the copy", () => {
  it("nothing can take the previous database while the copy runs", () => {
    const { previousDir, destinationDir } = seedPrevious();
    let heldDuringCopy: string | null = null;

    runUserDataMigration({
      previousDir,
      destinationDir,
      override: null,
      appVersion: APP_VERSION,
      onBeforeMarkerWrite: () => {
        const contender = acquirePreviousInstanceLock(previousDir);
        heldDuringCopy = contender.verdict;
        contender.release();
      },
    });

    expect(heldDuringCopy).toBe("running");
  });

  it("releases the lock once done, so the next launch is not blocked", () => {
    const { previousDir, destinationDir } = seedPrevious();
    run({ previousDir, destinationDir });

    const after = acquirePreviousInstanceLock(previousDir);
    cleanup.push(() => after.release());
    expect(after.verdict).toBe("not-running");
  });
});
