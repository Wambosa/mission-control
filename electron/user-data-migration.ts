/**
 * The side-effecting half of the first-launch migration: probe, copy, verify,
 * write the marker.
 *
 * Everything here is synchronous on purpose. This runs at main-process module
 * scope, before the app name is set and before any platform path is resolved,
 * which is the only point in startup where no database connection is open yet
 * and nothing has cached a stale directory. There is no top-level await on the
 * CommonJS emit, so an asynchronous backup API is not available to it.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { resolveElectronBetterSqlite3NativeBinding } from "./better-sqlite3-native-binding";
import { errMsg } from "../src/shared/err-msg";
import { acquirePreviousInstanceLock, type PreviousInstanceLock } from "./previous-instance";
import { previousInstanceRefusal } from "../src/shared/previous-instance";
import {
  ensureUserDataDir,
  restrictDbFilePermissions,
  userDataDbPath,
  USER_DATA_DB_FILENAME,
} from "../src/shared/user-data-paths";
import {
  MIGRATION_IDENTITY_SETTING_KEY,
  MIGRATION_MARKER_FILENAME,
  MIGRATION_MARKER_VERSION,
  OPTIONAL_MIGRATION_ENTRIES,
  REQUIRED_MIGRATION_ENTRIES,
  classifyMarker,
  decideMigration,
  detectPreviousStoreDivergence,
  previousDirectoryUnavailableMessage,
  type DbFingerprint,
  type MigrationEntry,
  type MigrationMarker,
  type MigrationOutcome,
  type PreviousStoreStamp,
} from "../src/shared/user-data-migration";

export type MigrationReport = {
  outcome: MigrationOutcome;
  /** The directory this session must use. Every consumer resolves to this. */
  directory: string;
  /** Non-null means the app must not start. Carries the operator's message. */
  refusal: string | null;
  /** Optional allowlist entries that did not come across. */
  skipped: string[];
  /** Human-readable detail for the log and the interface. */
  detail: string;
  /** The previous application has been used since the migration (R28). */
  divergence: boolean;
  previousDir: string;
  destinationDir: string;
};

export type MigrationInput = {
  previousDir: string;
  destinationDir: string;
  /** Already trimmed. Null when unset. */
  override: string | null;
  appVersion: string;
  /** Seam for the tests that need a deterministic temporary name. */
  temporarySuffix?: () => string;
  /** Seam for proving the lock is still held when the copy finishes. */
  onBeforeMarkerWrite?: () => void;
  acquireLock?: (previousDir: string) => PreviousInstanceLock;
};

export function runUserDataMigration(input: MigrationInput): MigrationReport {
  const base = {
    skipped: [] as string[],
    divergence: false,
    previousDir: input.previousDir,
    destinationDir: input.destinationDir,
  };

  // The override short-circuits everything, including the guard. A development
  // run forces it precisely so a working copy can run beside an installed
  // build, and the source is never even read.
  if (input.override) {
    return {
      ...base,
      outcome: "override",
      directory: input.override,
      refusal: null,
      detail: `Using the data folder named by the environment: ${input.override}`,
    };
  }

  const sourceDbPath = userDataDbPath(input.previousDir);
  // Stamped before the lock is taken, because taking it perturbs the very
  // thing being measured: the guard opens the previous database read-write,
  // which rewrites its sidecars. A baseline recorded once this app has let go
  // and a reading taken before it takes hold both describe the same phase —
  // the previous store while this app is not touching it — so a quiet launch
  // compares equal instead of reporting the guard's own footprint as the
  // previous application's work.
  const stampBeforeLock = stampPreviousStore(sourceDbPath);

  const acquire = input.acquireLock ?? acquirePreviousInstanceLock;
  const lock = acquire(input.previousDir);
  let outcome: { report: MigrationReport; baselineOwner: MigrationMarker | null };
  try {
    outcome = decideAndAct(input, lock, base, stampBeforeLock);
  } finally {
    // Released on every exit path, so a failed attempt never locks out the next.
    lock.release();
  }

  // Now that this app has stopped touching the source, record where it stands.
  // Best-effort: a failure here costs one repeated report, never the session.
  if (outcome.baselineOwner) {
    writeMarker(path.join(input.destinationDir, MIGRATION_MARKER_FILENAME), {
      ...outcome.baselineOwner,
      divergenceBaseline: stampPreviousStore(sourceDbPath),
    });
  }
  return outcome.report;
}

type ReportBase = {
  skipped: string[];
  divergence: boolean;
  previousDir: string;
  destinationDir: string;
};

type ActResult = { report: MigrationReport; baselineOwner: MigrationMarker | null };

function decideAndAct(
  input: MigrationInput,
  lock: PreviousInstanceLock,
  base: ReportBase,
  stampBeforeLock: PreviousStoreStamp | null,
): ActResult {
  const destinationDbPath = userDataDbPath(input.destinationDir);
  const markerPath = path.join(input.destinationDir, MIGRATION_MARKER_FILENAME);
  const sourceDbPath = userDataDbPath(input.previousDir);

  const marker = classifyMarker({
    raw: readFileOrNull(markerPath),
    destinationDbExists: fs.existsSync(destinationDbPath),
    destinationIdentity: readIdentity(destinationDbPath),
  });

  const sourceEntries = presentEntries(input.previousDir);
  const decision = decideMigration({
    override: null,
    previousInstanceRunning: lock.verdict === "running",
    marker,
    previousDirectoryReadable: isDirectoryReadable(input.previousDir),
    // Both come from the lock attempt rather than a second open: while the lock
    // is held, this process cannot open the source again either.
    sourceDatabasePresent: lock.reason !== "no-database",
    sourceDatabaseReadable: lock.reason === "locked",
    destinationHasDatabase: isReadableDatabase(destinationDbPath),
    sourceBytes: sourceEntries.reduce((sum, e) => sum + e.bytes, 0),
    freeBytesAtSource: freeBytes(nearestExistingDir(input.previousDir)),
    freeBytesAtDestination: freeBytes(nearestExistingDir(input.destinationDir)),
  });

  switch (decision.action) {
    case "use-override":
      // Unreachable: the override is handled before the lock is taken.
      return reportOnly({
        ...base,
        outcome: "override",
        directory: decision.directory,
        refusal: null,
        detail: "",
      });

    case "refuse":
      return reportOnly({
        ...base,
        outcome: "failed",
        directory: input.previousDir,
        refusal: previousInstanceRefusal({ previousDir: input.previousDir }),
        detail: `Another process holds ${sourceDbPath}.`,
      });

    case "refuse-unavailable":
      return reportOnly({
        ...base,
        outcome: "failed",
        directory: input.previousDir,
        refusal: previousDirectoryUnavailableMessage({
          previousDir: input.previousDir,
          destinationDir: input.destinationDir,
        }),
        detail: `The previous data folder ${input.previousDir} could not be opened.`,
      });

    case "use-destination": {
      const { diverged } = detectPreviousStoreDivergence(
        decision.marker.divergenceBaseline,
        stampBeforeLock,
      );
      return {
        // The baseline is refreshed after the lock is released, so it is
        // reported once per occurrence rather than on every launch.
        baselineOwner: decision.marker,
        report: {
          ...base,
          outcome: "already-migrated",
          directory: input.destinationDir,
          refusal: null,
          divergence: diverged,
          detail: diverged
            ? `Work has been written to the previous data folder ${input.previousDir} since the migration. This app cannot see it. Removing the previous application is what ends the divergence.`
            : "",
        },
      };
    }

    case "record-fresh-install":
      ensureUserDataDir(input.destinationDir);
      writeMarker(markerPath, {
        markerVersion: MIGRATION_MARKER_VERSION,
        appVersion: input.appVersion,
        outcome: "no-previous-directory",
        sourcePath: input.previousDir,
        skipped: [],
        identity: mintIdentity(),
        fingerprint: null,
        divergenceBaseline: null,
      });
      return reportOnly({
        ...base,
        outcome: "no-previous-directory",
        directory: input.destinationDir,
        refusal: null,
        detail: "No previous data folder was found. Starting fresh.",
      });

    case "report-conflict":
      return reportOnly({
        ...base,
        outcome: "destination-conflict",
        directory: input.previousDir,
        refusal: null,
        detail: `A database already exists at ${destinationDbPath} with no record of a completed migration. Nothing was copied or deleted; this session continues on ${input.previousDir}.`,
      });

    case "fail":
      return reportOnly({
        ...base,
        outcome: "failed",
        directory: input.previousDir,
        refusal: null,
        detail: `${decision.reason} This session continues on ${input.previousDir}.`,
      });

    case "copy":
      return copyForward(input, sourceEntries, lock, base);
  }
}

// ---------------------------------------------------------------------------
// The copy
// ---------------------------------------------------------------------------

type PresentEntry = MigrationEntry & { required: boolean; bytes: number };

function reportOnly(report: MigrationReport): ActResult {
  return { report, baselineOwner: null };
}

function copyForward(
  input: MigrationInput,
  sourceEntries: PresentEntry[],
  lock: PreviousInstanceLock,
  base: ReportBase,
): ActResult {
  const suffix = input.temporarySuffix ?? (() => `${process.pid}.${Date.now()}`);
  const staged: Array<{ temp: string; final: string }> = [];
  const skipped: string[] = [];
  const landed: string[] = [];

  const fail = (reason: string): ActResult => {
    // A partial file left at the live database filename makes every retry fail
    // permanently, so both the temporaries and anything already renamed into
    // place come back out.
    for (const { temp } of staged) removeQuietly(temp);
    for (const final of landed) removeQuietly(final);
    return reportOnly({
      ...base,
      outcome: "failed",
      directory: input.previousDir,
      refusal: null,
      skipped,
      detail: `${reason} This session continues on ${input.previousDir}.`,
    });
  };

  try {
    ensureUserDataDir(input.destinationDir);
  } catch (error) {
    return fail(
      `The new data folder ${input.destinationDir} could not be created (${errMsg(error)}).`,
    );
  }

  // Stage everything as siblings inside the destination — never the system
  // temp directory, where the rename would silently degrade into a
  // cross-filesystem copy and defeat the commit point.
  for (const entry of sourceEntries) {
    const source = path.join(input.previousDir, entry.name);
    const final = path.join(input.destinationDir, entry.name);
    const temp = `${final}.${suffix()}.tmp`;
    try {
      if (fs.existsSync(temp)) {
        throw new Error(`a file already exists at the staging path ${temp}`);
      }
      if (entry.kind === "directory") {
        // force:false is what makes errorOnExist bite — cpSync overwrites by
        // default, so without it a staging path that already exists would be
        // merged into rather than refused.
        fs.cpSync(source, temp, { recursive: true, force: false, errorOnExist: true });
      } else {
        fs.copyFileSync(source, temp, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(temp, 0o600);
      }
      staged.push({ temp, final });
    } catch (error) {
      if (entry.required) {
        return fail(`${entry.name} could not be copied (${errMsg(error)}).`);
      }
      removeQuietly(temp);
      skipped.push(entry.name);
    }
  }

  // Verify before anything claims the live filenames.
  const stagedDb = staged.find((s) => s.final === userDataDbPath(input.destinationDir));
  if (!stagedDb) return fail("The database was not staged.");
  const stagedWal = staged.find((s) => s.final.endsWith(`${USER_DATA_DB_FILENAME}-wal`));

  let fingerprint: { source: DbFingerprint; destination: DbFingerprint };
  const identity = mintIdentity();
  try {
    // The staged pair has to be verified as a pair: a write-ahead log named
    // after the temporary database is what makes its committed transactions
    // visible to the reader.
    const verifyDbPath = stagedDb.temp;
    if (stagedWal) fs.renameSync(stagedWal.temp, `${verifyDbPath}-wal`);
    const source = lock.source;
    if (!source) throw new Error("the exclusive lock on the previous database was not held");
    fingerprint = verifyCopy(source, verifyDbPath);
    writeIdentity(verifyDbPath, identity);
    if (stagedWal) {
      if (fs.existsSync(`${verifyDbPath}-wal`)) {
        fs.renameSync(`${verifyDbPath}-wal`, stagedWal.temp);
      } else {
        // The reads checkpointed the log into the database; nothing left to move.
        staged.splice(staged.indexOf(stagedWal), 1);
      }
    }
  } catch (error) {
    removeQuietly(`${stagedDb.temp}-wal`);
    removeQuietly(`${stagedDb.temp}-shm`);
    return fail(`The copy could not be verified (${errMsg(error)}).`);
  }

  // Commit: rename each staged file into place.
  try {
    for (const { temp, final } of staged) {
      if (fs.existsSync(final)) removeQuietly(final);
      fs.renameSync(temp, final);
      landed.push(final);
    }
  } catch (error) {
    return fail(`The copy could not be moved into place (${errMsg(error)}).`);
  }

  removeQuietly(`${stagedDb.temp}-shm`);
  restrictDbFilePermissions(userDataDbPath(input.destinationDir));

  input.onBeforeMarkerWrite?.();

  // The source stamp is taken after every source read has finished —
  // verification itself can touch the source, so the marker's own timestamp
  // would be the wrong baseline.
  const outcome: MigrationOutcome = skipped.length ? "migrated-with-skipped" : "migrated";
  const marker: MigrationMarker = {
    markerVersion: MIGRATION_MARKER_VERSION,
    appVersion: input.appVersion,
    outcome,
    sourcePath: input.previousDir,
    skipped,
    identity,
    fingerprint,
    // Provisional: refreshed once the lock is released, so the recorded
    // baseline describes the source as it sits with nobody holding it.
    divergenceBaseline: stampPreviousStore(userDataDbPath(input.previousDir)),
  };
  if (!writeMarker(path.join(input.destinationDir, MIGRATION_MARKER_FILENAME), marker)) {
    return fail(`The migration record could not be written to ${input.destinationDir}.`);
  }

  return {
    baselineOwner: marker,
    report: {
      ...base,
      outcome,
      directory: input.destinationDir,
      refusal: null,
      skipped,
      detail: skipped.length
        ? `Data carried forward from ${input.previousDir}. These were left behind: ${skipped.join(", ")}.`
        : `Data carried forward from ${input.previousDir}.`,
    },
  };
}

/**
 * Row-level and credential-level equality, not an integrity check.
 *
 * An integrity check is necessary and nowhere near sufficient: an empty
 * database passes one. So this compares per-table row counts, the
 * applied-migration list, and **digests** of the credential columns rather than
 * their values — a mismatch message must be able to name the table and the
 * column without ever naming a token, because the log directory is what the
 * diagnostics export bundles.
 */
function verifyCopy(
  source: Database.Database,
  destinationDbPath: string,
): { source: DbFingerprint; destination: DbFingerprint } {
  let destination: Database.Database | null = null;
  try {
    destination = openReadOnly(destinationDbPath);

    const sourceTables = userTables(source);
    const destinationTables = userTables(destination);
    if (sourceTables.join(",") !== destinationTables.join(",")) {
      throw new Error("the copy does not carry the same tables as the source");
    }

    const sourcePrint = fingerprint(source, sourceTables);
    const destinationPrint = fingerprint(destination, destinationTables);

    for (const table of sourceTables) {
      if (sourcePrint.rowCounts[table] !== destinationPrint.rowCounts[table]) {
        throw new Error(
          `row count for ${table} differs: ${sourcePrint.rowCounts[table]} in the source, ${destinationPrint.rowCounts[table]} in the copy`,
        );
      }
    }

    for (const [table, column, keyColumn] of CREDENTIAL_COLUMNS) {
      if (!sourceTables.includes(table)) continue;
      if (
        credentialDigest(source, table, column, keyColumn) !==
        credentialDigest(destination, table, column, keyColumn)
      ) {
        throw new Error(`${table}.${column} does not match the source`);
      }
    }

    // Deliberately not asserting that the copy carries any particular table.
    // The table sets were compared above, so such a check could only ever fire
    // on a *source* that lacks it — and a previous install whose database was
    // created by the Electron-side stores holds only `app_settings`, because
    // the server had not bootstrapped the schema yet. That store still holds a
    // real bearer token worth carrying, and the destination bootstraps its
    // schema on first connection exactly as the source would have. Failing it
    // here would put such an install into a permanent migration-failure loop.

    return { source: sourcePrint, destination: destinationPrint };
  } finally {
    // The source connection belongs to the lock and stays open — releasing the
    // lock is what closes it.
    closeQuietly(destination);
  }
}

/** The columns holding state that cannot be regenerated, checked by digest. */
const CREDENTIAL_COLUMNS: Array<[table: string, column: string, keyColumn: string]> = [
  ["app_settings", "value", "key"],
  ["sandboxes", "pairing_token", "id"],
  ["schema_migrations", "name", "name"],
];

function credentialDigest(
  db: Database.Database,
  table: string,
  column: string,
  keyColumn: string,
): string {
  const rows = db
    .prepare(`SELECT "${keyColumn}" AS k, "${column}" AS v FROM "${table}" ORDER BY "${keyColumn}"`)
    .all() as Array<{ k: unknown; v: unknown }>;
  const hash = crypto.createHash("sha256");
  // NUL-separated because it cannot occur in any value being hashed, so no
  // pair of different row sets can produce the same input.
  for (const row of rows) hash.update(`${String(row.k)}\0${String(row.v)}\0`);
  return hash.digest("hex");
}

function userTables(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function fingerprint(db: Database.Database, tables: string[]): DbFingerprint {
  const rowCounts: Record<string, number> = {};
  for (const table of tables) {
    rowCounts[table] = (
      db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }
    ).n;
  }
  return { pageCount: Number(db.pragma("page_count", { simple: true })), rowCounts };
}

// ---------------------------------------------------------------------------
// Filesystem and database helpers
// ---------------------------------------------------------------------------

function presentEntries(dir: string): PresentEntry[] {
  const out: PresentEntry[] = [];
  for (const [entries, required] of [
    [REQUIRED_MIGRATION_ENTRIES, true],
    [OPTIONAL_MIGRATION_ENTRIES, false],
  ] as const) {
    for (const entry of entries) {
      const bytes = sizeOf(path.join(dir, entry.name));
      if (bytes === null) continue;
      out.push({ ...entry, required, bytes });
    }
  }
  return out;
}

function sizeOf(target: string): number | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return null;
  let total = 0;
  try {
    for (const child of fs.readdirSync(target)) {
      total += sizeOf(path.join(target, child)) ?? 0;
    }
  } catch {
    /* an unreadable subtree contributes nothing to the estimate */
  }
  return total;
}

function isDirectoryReadable(dir: string): boolean {
  try {
    fs.readdirSync(dir);
    return true;
  } catch (error) {
    // A directory that is not there is not the same as one that cannot be read.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function isReadableDatabase(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  let db: Database.Database | null = null;
  try {
    db = openReadOnly(dbPath);
    db.prepare("SELECT name FROM sqlite_master LIMIT 1").all();
    return true;
  } catch {
    return false;
  } finally {
    closeQuietly(db);
  }
}

function nearestExistingDir(dir: string): string {
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function freeBytes(dir: string): number {
  try {
    const stat = fs.statfsSync(dir);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    // Unknown free space must not read as no free space — that would block
    // every migration on a platform without statfs.
    return Number.MAX_SAFE_INTEGER;
  }
}

function stampPreviousStore(sourceDbPath: string): PreviousStoreStamp | null {
  let newestMtimeMs = 0;
  let totalBytes = 0;
  let seen = false;
  for (const candidate of [sourceDbPath, `${sourceDbPath}-wal`]) {
    try {
      const stat = fs.statSync(candidate);
      seen = true;
      newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
      totalBytes += stat.size;
    } catch {
      /* an absent sidecar contributes nothing */
    }
  }
  return seen ? { newestMtimeMs, totalBytes } : null;
}

function openReadOnly(dbPath: string): Database.Database {
  return new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
    nativeBinding: resolveElectronBetterSqlite3NativeBinding(),
  });
}

function readIdentity(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = openReadOnly(dbPath);
    const row = db
      .prepare("SELECT value FROM app_settings WHERE key = ?")
      .get(MIGRATION_IDENTITY_SETTING_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  } finally {
    closeQuietly(db);
  }
}

function writeIdentity(dbPath: string, identity: string): void {
  const db = new Database(dbPath, {
    fileMustExist: true,
    nativeBinding: resolveElectronBetterSqlite3NativeBinding(),
  });
  try {
    db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(MIGRATION_IDENTITY_SETTING_KEY, identity);
  } finally {
    closeQuietly(db);
  }
}

function mintIdentity(): string {
  return `mig-${crypto.randomBytes(12).toString("hex")}`;
}

function writeMarker(markerPath: string, marker: MigrationMarker): boolean {
  const temp = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, markerPath);
    return true;
  } catch {
    removeQuietly(temp);
    return false;
  }
}

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function removeQuietly(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function closeQuietly(db: Database.Database | null): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* best effort */
  }
}

