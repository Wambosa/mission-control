/**
 * Is a previous-identity instance of this app running?
 *
 * The verdict comes from trying to take an exclusive lock on the previous
 * user-data directory's database. That choice is deliberate: it is synchronous,
 * so it can answer at module scope where the migration runs; it sees every
 * holder including the bundled command-line tool, which binds no port; and
 * success does not merely *infer* that nothing else is writing — it guarantees
 * nothing can start, for as long as the lock is held.
 *
 * This half classifies a lock attempt. The Electron half owns the database
 * handle, because a synchronous open needs the native binding.
 */

export { USER_DATA_DIR_ENV_VAR } from "./user-data-paths";

import { USER_DATA_DIR_ENV_VAR } from "./user-data-paths";

/** Whether a previous-identity instance holds the previous data directory. */
export type PreviousInstanceVerdict = "running" | "not-running";

/** Why the guard reached its verdict. */
export type PreviousInstanceReason =
  /** The exclusive lock was acquired — nothing else holds the database. */
  | "locked"
  /** Something else holds the database. */
  | "busy"
  /** The previous directory carries no database. */
  | "no-database"
  /** The database is there but could not be opened. */
  | "unreadable";

export type PreviousInstanceProbe =
  | { kind: "locked" }
  | { kind: "busy"; detail: string }
  | { kind: "no-database" }
  | { kind: "unreadable"; detail: string };

/**
 * Only a busy lock means something is running.
 *
 * An unreadable database is deliberately *not* a refusal to start: the
 * migration's own source check produces that failure, with a message about the
 * source rather than a misleading claim that another copy is running.
 */
export function verdictForProbe(probe: PreviousInstanceProbe): PreviousInstanceVerdict {
  return probe.kind === "busy" ? "running" : "not-running";
}

const BUSY_CODES = new Set(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_BUSY_RECOVERY"]);

/**
 * Distinguish "another process holds this" from every other way an open can
 * fail. Getting this wrong in either direction is costly: a missed busy result
 * lets two builds drive the same remote hosts with the same live pairing
 * tokens, and a false busy result locks the user out of their own app.
 */
export function isDatabaseBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && BUSY_CODES.has(code)) return true;
  // Some driver paths surface the condition without a code.
  return /database is locked/i.test(error.message);
}

/**
 * What the operator sees when the app refuses to start.
 *
 * Names the holder and the way through. The app has not checked *which*
 * process holds the database, so the wording stays with what is known: the
 * directory, and that something is using it.
 */
export function previousInstanceRefusal(input: { previousDir: string }): string {
  return [
    `The previous version of this app is already running, or another process is using its data.`,
    `Its data folder is ${input.previousDir}.`,
    `Quit the previous version — including any of its command-line tools — and start this app again.`,
    `To start anyway against a different data folder, set ${USER_DATA_DIR_ENV_VAR} to an absolute path.`,
  ].join("\n");
}
