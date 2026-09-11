/**
 * Where this app keeps its own data, and what the database inside it is called.
 *
 * One module, six readers: the main process (which also hands the resolved
 * directory to the server child and every Electron-side store), the database
 * client, the four Electron stores that open the same file directly, and the
 * schema-migration config. The directory name is load-bearing — it selects the
 * projects, tasks, prompts, API bearer token and sandbox pairing tokens the app
 * can see — so a literal duplicated per consumer is a split-brain waiting for
 * one of them to be edited alone.
 *
 * The remote-VM CLI is the one sanctioned exception: the package ships that
 * script without the source tree, so it keeps its own copy of these values,
 * pinned to this module by a cross-file agreement test rather than an import.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The two name forms live in their own dependency-free module so the renderer
// can import the display name without pulling `node:fs` into the client graph.
export { PRODUCT_DISPLAY_NAME, USER_DATA_DIR_NAME } from "./product-name";

import { USER_DATA_DIR_NAME } from "./product-name";

/** The database file inside the user-data directory. */
export const USER_DATA_DB_FILENAME = "missioncontrol.db";

/**
 * The escape hatch. Keeps its historical name on purpose: it is the override
 * reached for when directory resolution has gone wrong, so renaming it would
 * remove the rescue path from the operation that needs rescuing.
 */
export const USER_DATA_DIR_ENV_VAR = "MC_USER_DATA_DIR";

/**
 * The override, or null when it is unset or blank.
 *
 * Blank counts as unset. Three of the four historical resolvers disagreed here
 * — one returned the untrimmed whitespace, one returned an empty string, one
 * fell through — which meant a mistyped rescue variable sent consumers to
 * different directories.
 */
export function userDataDirOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const trimmed = env[USER_DATA_DIR_ENV_VAR]?.trim();
  return trimmed ? trimmed : null;
}

/** The platform's conventional location, ignoring any override. */
export function defaultUserDataDir(
  platform: string = process.platform,
  home: string = os.homedir(),
): string {
  if (!home?.trim()) {
    // path.join("", "…") yields a relative path, which would silently plant a
    // data directory in whatever the current working directory happens to be.
    throw new Error(
      `Cannot determine the home directory, so the ${USER_DATA_DIR_NAME} data directory cannot be resolved. Set ${USER_DATA_DIR_ENV_VAR} to an absolute path.`,
    );
  }
  if (platform === "darwin") {
    return path.join(home, "Library/Application Support", USER_DATA_DIR_NAME);
  }
  if (platform === "win32") {
    return path.join(home, "AppData/Roaming", USER_DATA_DIR_NAME);
  }
  return path.join(home, ".config", USER_DATA_DIR_NAME);
}

/** The user-data directory: the override when set, else the platform default. */
export function resolveUserDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = os.homedir(),
): string {
  return userDataDirOverride(env) ?? defaultUserDataDir(platform, home);
}

/** The skills directory the app writes into its own user-data directory. */
export function resolveSkillsDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = os.homedir(),
): string {
  return path.join(resolveUserDataDir(env, platform, home), "skills");
}

/** The database file inside a given user-data directory. */
export function userDataDbPath(userDataDir: string): string {
  return path.join(userDataDir, USER_DATA_DB_FILENAME);
}

/**
 * Create the user-data directory owner-only, and tighten it if it already
 * exists.
 *
 * The repair is the point. `mkdirSync({ recursive: true, mode })` applies the
 * mode only to directories it actually creates, so an install whose directory
 * predates the mode argument stays world-readable forever — which is why the
 * live directory is world-readable today, with the bearer token and every
 * pairing token in cleartext inside it.
 *
 * Best-effort on the chmod: on filesystems and platforms without POSIX modes it
 * is a harmless no-op.
 */
export function ensureUserDataDir(userDataDir: string): string {
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(userDataDir, 0o700);
  } catch {
    /* best effort */
  }
  return userDataDir;
}

/**
 * Lock the database and its sidecars to owner-only.
 *
 * The database holds the API bearer token and every sandbox pairing token in
 * cleartext. Created with default permissions it is world-readable (~0644), so
 * any other local user, backup or sync process can lift those secrets straight
 * off disk. Best-effort for the same reason as above.
 */
export function restrictDbFilePermissions(dbPath: string): void {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (fs.existsSync(p)) fs.chmodSync(p, 0o600);
    } catch {
      /* best effort */
    }
  }
}
