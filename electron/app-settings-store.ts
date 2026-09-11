import Database from "better-sqlite3";
import { resolveElectronBetterSqlite3NativeBinding } from "./better-sqlite3-native-binding";
import {
  ensureUserDataDir,
  restrictDbFilePermissions,
  userDataDbPath,
} from "../src/shared/user-data-paths";

let _db: Database.Database | null = null;

function openDb(userDataDir: string): Database.Database {
  if (_db) return _db;
  const dbPath = userDataDbPath(ensureUserDataDir(userDataDir));
  const db = new Database(dbPath, {
    nativeBinding: resolveElectronBetterSqlite3NativeBinding(),
  });
  db.pragma("journal_mode = WAL");
  // Wait (up to 5s) for a concurrent checkpoint/writer instead of throwing
  // SQLITE_BUSY the instant the server process holds the write lock.
  db.pragma("busy_timeout = 5000");
  restrictDbFilePermissions(dbPath);
  db.exec(
    `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  );
  _db = db;
  return db;
}

export function getBooleanAppSetting(
  userDataDir: string,
  key: string,
  defaultValue = false,
): boolean {
  const db = openDb(userDataDir);
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (!row) return defaultValue;
  return row.value === "true";
}

export function getStringAppSetting(userDataDir: string, key: string): string | null {
  const db = openDb(userDataDir);
  const row = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setAppSetting(userDataDir: string, key: string, value: string): void {
  const db = openDb(userDataDir);
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, value);
}

export function deleteAppSetting(userDataDir: string, key: string): void {
  const db = openDb(userDataDir);
  db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
}

export function disposeAppSettingsStore(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* best effort */
    }
    _db = null;
  }
}
