import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { acquirePreviousInstanceLock } from "../previous-instance";
import { USER_DATA_DB_FILENAME } from "../../src/shared/user-data-paths";

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

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "previous-instance-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A previous-identity directory carrying a WAL-mode database with a token in it. */
function seedPreviousDir(): { dir: string; dbPath: string } {
  const dir = tmpDir();
  const dbPath = path.join(dir, USER_DATA_DB_FILENAME);
  const seed = new Database(dbPath);
  seed.pragma("journal_mode = WAL");
  seed.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  seed.prepare("INSERT INTO app_settings VALUES (?, ?)").run("api_token", "secret");
  seed.close();
  return { dir, dbPath };
}

function openHolder(dbPath: string, options: Database.Options = {}): Database.Database {
  const holder = new Database(dbPath, options);
  cleanup.push(() => holder.close());
  return holder;
}

describe("acquirePreviousInstanceLock", () => {
  it("reports not running and holds the lock when nothing else has the database", () => {
    const { dir, dbPath } = seedPreviousDir();

    const lock = acquirePreviousInstanceLock(dir);
    cleanup.push(() => lock.release());

    expect(lock.verdict).toBe("not-running");

    // The lock is held, not merely probed: nothing else can take it meanwhile.
    // This is what enforces the no-writer precondition across the copy.
    const second = acquirePreviousInstanceLock(dir);
    expect(second.verdict).toBe("running");
    second.release();

    expect(fs.existsSync(dbPath)).toBe(true);
  });

  it("reports running when another connection holds a write transaction (AE11)", () => {
    const { dir, dbPath } = seedPreviousDir();
    const holder = openHolder(dbPath);
    holder.pragma("journal_mode = WAL");
    holder.exec("BEGIN IMMEDIATE");

    const lock = acquirePreviousInstanceLock(dir);
    cleanup.push(() => lock.release());

    expect(lock.verdict).toBe("running");
    expect(lock.reason).toBe("busy");
  });

  it("reports running for a bare command-line holder with no window and no port (AE18)", () => {
    // The case a port-file liveness probe could not see: the bundled CLI opens
    // the database directly and binds nothing. It holds no transaction — just
    // an open connection that has read once.
    const { dir, dbPath } = seedPreviousDir();
    const holder = openHolder(dbPath, { readonly: true });
    holder.prepare("SELECT * FROM app_settings").all();

    const lock = acquirePreviousInstanceLock(dir);
    cleanup.push(() => lock.release());

    expect(lock.verdict).toBe("running");
  });

  it("reports running when a reader holds an open read transaction", () => {
    const { dir, dbPath } = seedPreviousDir();
    const holder = openHolder(dbPath, { readonly: true });
    holder.exec("BEGIN");
    holder.prepare("SELECT * FROM app_settings").all();

    const lock = acquirePreviousInstanceLock(dir);
    cleanup.push(() => lock.release());

    expect(lock.verdict).toBe("running");
  });

  it("reports not running for a previous directory with no database, and creates none", () => {
    const dir = tmpDir();

    const lock = acquirePreviousInstanceLock(dir);
    cleanup.push(() => lock.release());

    expect(lock.verdict).toBe("not-running");
    expect(lock.reason).toBe("no-database");
    expect(fs.existsSync(path.join(dir, USER_DATA_DB_FILENAME))).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("reports not running when the previous directory does not exist at all", () => {
    const dir = path.join(tmpDir(), "never-existed");

    const lock = acquirePreviousInstanceLock(dir);
    cleanup.push(() => lock.release());

    expect(lock.verdict).toBe("not-running");
    expect(lock.reason).toBe("no-database");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("reports not running rather than throwing when the database is unreadable", () => {
    const { dir, dbPath } = seedPreviousDir();
    fs.chmodSync(dbPath, 0o000);
    cleanup.push(() => fs.chmodSync(dbPath, 0o600));

    let lock;
    expect(() => {
      lock = acquirePreviousInstanceLock(dir);
    }).not.toThrow();
    expect(lock!.verdict).toBe("not-running");
    expect(lock!.reason).toBe("unreadable");
    lock!.release();
  });

  it("reports not running rather than throwing when the file is not a database", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, USER_DATA_DB_FILENAME), "this is not a database");

    const lock = acquirePreviousInstanceLock(dir);
    cleanup.push(() => lock.release());

    expect(lock.verdict).toBe("not-running");
    expect(lock.reason).toBe("unreadable");
  });

  it("releases the lock so a retry after a failed copy is not blocked", () => {
    const { dir } = seedPreviousDir();

    const first = acquirePreviousInstanceLock(dir);
    expect(first.verdict).toBe("not-running");
    first.release();

    const retry = acquirePreviousInstanceLock(dir);
    cleanup.push(() => retry.release());
    expect(retry.verdict).toBe("not-running");
  });

  it("is safe to release more than once", () => {
    const { dir } = seedPreviousDir();

    const lock = acquirePreviousInstanceLock(dir);
    lock.release();
    expect(() => lock.release()).not.toThrow();

    const retry = acquirePreviousInstanceLock(dir);
    cleanup.push(() => retry.release());
    expect(retry.verdict).toBe("not-running");
  });

  it("releases cleanly on a verdict of running, holding nothing open", () => {
    const { dir, dbPath } = seedPreviousDir();
    const holder = openHolder(dbPath);
    holder.pragma("journal_mode = WAL");
    holder.exec("BEGIN IMMEDIATE");

    const lock = acquirePreviousInstanceLock(dir);
    expect(lock.verdict).toBe("running");
    expect(() => lock.release()).not.toThrow();

    // The refused attempt left nothing behind: once the real holder is gone the
    // guard acquires. An open-but-idle connection still counts as a holder —
    // that is the whole reason the lock runs in exclusive locking mode — so the
    // holder has to actually close, not merely end its transaction.
    holder.exec("ROLLBACK");
    holder.close();

    const after = acquirePreviousInstanceLock(dir);
    cleanup.push(() => after.release());
    expect(after.verdict).toBe("not-running");
  });
});
