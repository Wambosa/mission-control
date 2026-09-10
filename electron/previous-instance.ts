/**
 * The Electron half of the previous-instance guard: it owns the database
 * handle and the lock, so the migration can hold the exclusion across its copy
 * rather than probing twice and hoping nothing moved in between.
 */

import * as fs from "node:fs";
import Database from "better-sqlite3";
import { resolveElectronBetterSqlite3NativeBinding } from "./better-sqlite3-native-binding";
import { userDataDbPath } from "../src/shared/user-data-paths";
import {
  type PreviousInstanceProbe,
  type PreviousInstanceReason,
  type PreviousInstanceVerdict,
  isDatabaseBusyError,
  verdictForProbe,
} from "../src/shared/previous-instance";

export type PreviousInstanceLock = {
  readonly verdict: PreviousInstanceVerdict;
  readonly reason: PreviousInstanceReason;
  /** Detail for the log. Empty when there was nothing to say. */
  readonly detail: string;
  /**
   * Drop the lock. Safe to call more than once and safe to call on a verdict of
   * `running`, where there is nothing to drop — a failed copy must not leave
   * the next launch locked out by its own previous attempt.
   */
  release(): void;
};

/**
 * Try to take an exclusive lock on the previous directory's database.
 *
 * Two pragmas carry the weight:
 *
 * - `timeout: 0` — no busy timeout. The point is an immediate verdict, not a
 *   wait. A launch must not hang behind a running previous instance.
 * - `locking_mode = EXCLUSIVE` — without it, `BEGIN EXCLUSIVE` on a WAL
 *   database succeeds while another connection sits open and idle, which is
 *   precisely what a running previous app looks like between writes. Under
 *   exclusive locking mode the attempt fails while *any* other connection
 *   holds the database, including a read-only one, which is what makes the
 *   bundled command-line tool detectable.
 *
 * `fileMustExist` keeps the probe from manufacturing the database it is asking
 * about.
 */
export function acquirePreviousInstanceLock(previousDir: string): PreviousInstanceLock {
  const dbPath = userDataDbPath(previousDir);

  if (!fs.existsSync(dbPath)) return settled({ kind: "no-database" }, null);

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, {
      timeout: 0,
      fileMustExist: true,
      nativeBinding: resolveElectronBetterSqlite3NativeBinding(),
    });
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const probe: PreviousInstanceProbe = isDatabaseBusyError(error)
      ? { kind: "busy", detail }
      : { kind: "unreadable", detail };
    closeQuietly(db, false);
    return settled(probe, null);
  }

  return settled({ kind: "locked" }, db);
}

function settled(probe: PreviousInstanceProbe, held: Database.Database | null): PreviousInstanceLock {
  let open = held;
  return {
    verdict: verdictForProbe(probe),
    reason: probe.kind,
    detail: "detail" in probe ? probe.detail : "",
    release() {
      const db = open;
      open = null;
      closeQuietly(db, true);
    },
  };
}

/**
 * Closing the connection is what actually surrenders the lock — under
 * exclusive locking mode a rollback alone keeps the file lock until the
 * connection goes away.
 */
function closeQuietly(db: Database.Database | null, rollback: boolean): void {
  if (!db) return;
  if (rollback) {
    try {
      if (db.inTransaction) db.exec("ROLLBACK");
    } catch {
      /* best effort */
    }
  }
  try {
    db.close();
  } catch {
    /* best effort */
  }
}
