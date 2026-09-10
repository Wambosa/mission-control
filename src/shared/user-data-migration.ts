/**
 * Carrying the previous install's data forward on first launch under the new
 * identity.
 *
 * This half is pure: it owns the allowlist, the marker's shape, the launch-time
 * validity predicate and the decision, so all four can be tested without a
 * filesystem. The Electron half performs the copy — a synchronous database copy
 * needs the native binding a pure module cannot reach.
 */

import {
  USER_DATA_DB_FILENAME,
  USER_DATA_DIR_ENV_VAR,
  USER_DATA_DIR_NAME,
} from "./user-data-paths";

/**
 * The previous data directory's name, hard-coded.
 *
 * Deliberately a literal rather than something derived from the current brand
 * constant: the previous name is the only handle on the state being migrated,
 * and deriving it would make this silently target nothing the moment the brand
 * constant moves — which is the very change this exists to support.
 */
export const PREVIOUS_USER_DATA_DIR_NAME = "MissionControl";

/** Written last. Its presence plus validity is the commit point. */
export const MIGRATION_MARKER_FILENAME = ".user-data-migration.json";

/** Bumped when the marker's shape changes. A newer marker is a hard stop. */
export const MIGRATION_MARKER_VERSION = 1;

/**
 * The identity the launch-time check reads back out of the destination
 * database. Minted at copy time and written into the copy, so a database that
 * is merely structurally valid — an empty one, say — cannot pass for the copy
 * the marker describes.
 */
export const MIGRATION_IDENTITY_SETTING_KEY = "user_data_migration_id";

/**
 * Refuse a source larger than this rather than copying it synchronously at
 * launch. The allowlist keeps a real install at roughly 7 MB, so hitting this
 * means something unexpected is in the directory.
 */
export const MAX_MIGRATION_SOURCE_BYTES = 512 * 1024 * 1024;

/** Headroom demanded at each end on top of the payload itself. */
export const MIGRATION_FREE_SPACE_HEADROOM_BYTES = 64 * 1024 * 1024;

export type MigrationEntry = {
  readonly name: string;
  readonly kind: "file" | "directory";
};

/**
 * The database and its write-ahead log, copied as a synchronous pair.
 *
 * The log is routinely larger than the database itself, so copying the database
 * alone silently loses committed transactions. The shared-memory sidecar is
 * deliberately absent — the next reader rebuilds it.
 */
export const REQUIRED_MIGRATION_ENTRIES: readonly MigrationEntry[] = [
  { name: USER_DATA_DB_FILENAME, kind: "file" },
  { name: `${USER_DATA_DB_FILENAME}-wal`, kind: "file" },
];

/**
 * Scratch state worth keeping, none of it worth failing a migration over.
 *
 * Everything the browser engine owns — caches, per-origin storage, cookies,
 * crash dumps — is excluded: it regenerates, and this codebase already treats
 * the renderer's browser-local storage as ephemeral because a port change makes
 * it a new origin. That exclusion turns a 76 MB copy into roughly 7 MB, which
 * is what makes verification, the space pre-flight and crash-safety cheap.
 *
 * `directory-grants.json` is excluded on purpose and is not merely forgotten:
 * it records directory authorizations the operating system revokes along with
 * the identifier change, so carrying it forward would leave the app believing
 * in grants the platform no longer holds.
 */
export const OPTIONAL_MIGRATION_ENTRIES: readonly MigrationEntry[] = [
  { name: ".port", kind: "file" },
  { name: ".window-bg", kind: "file" },
  { name: "window-state.json", kind: "file" },
  { name: "project-images", kind: "directory" },
  { name: "terminal-images", kind: "directory" },
];

/** R9's five recorded states, plus the two that write no marker. */
export type MigrationOutcome =
  | "override"
  | "already-migrated"
  | "no-previous-directory"
  | "migrated"
  | "migrated-with-skipped"
  | "destination-conflict"
  | "failed";

export type DbFingerprint = {
  pageCount: number;
  rowCounts: Record<string, number>;
};

/** What the previous store looked like after every source read had finished. */
export type PreviousStoreStamp = {
  newestMtimeMs: number;
  totalBytes: number;
};

export type MigrationMarker = {
  markerVersion: number;
  appVersion: string;
  outcome: MigrationOutcome;
  sourcePath: string;
  skipped: string[];
  identity: string;
  /** The copy-time verification record. Never re-compared at launch. */
  fingerprint: { source: DbFingerprint; destination: DbFingerprint } | null;
  /** R28's divergence baseline. Null on a fresh install. */
  divergenceBaseline: PreviousStoreStamp | null;
};

export type MarkerValidity =
  | { kind: "valid"; marker: MigrationMarker }
  | { kind: "absent" }
  | { kind: "unparseable"; detail: string }
  | { kind: "unknown-version"; version: number }
  | { kind: "identity-mismatch"; expected: string; found: string | null }
  | { kind: "database-missing" };

function isMarkerShaped(value: unknown): value is MigrationMarker {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.markerVersion === "number" &&
    typeof m.appVersion === "string" &&
    typeof m.outcome === "string" &&
    typeof m.sourcePath === "string" &&
    Array.isArray(m.skipped) &&
    typeof m.identity === "string"
  );
}

/**
 * Decide whether a completion marker still describes the destination.
 *
 * Narrow on purpose. The marker's fingerprint — page counts and per-table row
 * counts — is the *copy-time* gate, and it is never re-compared here: those
 * numbers move the instant the user creates anything, so re-comparing them
 * would fail every healthy install on the first launch after it is used.
 *
 * What is checked is what ordinary use does not move: the marker parses, this
 * build understands its version, and the destination database still carries the
 * identity recorded at copy time. Presence alone is not validity — an empty
 * database passes an integrity check, so integrity checking cannot tell a good
 * copy from an empty one. Anything inconsistent is a loud failure and never a
 * fresh install.
 */
export function classifyMarker(input: {
  raw: string | null;
  destinationDbExists: boolean;
  destinationIdentity: string | null;
}): MarkerValidity {
  if (input.raw === null) return { kind: "absent" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch (error) {
    return { kind: "unparseable", detail: error instanceof Error ? error.message : String(error) };
  }
  if (!isMarkerShaped(parsed)) {
    return { kind: "unparseable", detail: "marker is missing required fields" };
  }
  if (parsed.markerVersion > MIGRATION_MARKER_VERSION) {
    return { kind: "unknown-version", version: parsed.markerVersion };
  }
  // A fresh-install marker records that there was nothing to carry forward. It
  // exists so the standalone entry points stop resolving the previous
  // directory on a machine that never had the previous version — it does not
  // vouch for a copy, and the database it would be checked against has not
  // been created yet at the point the marker is written.
  if (parsed.outcome === "no-previous-directory") return { kind: "valid", marker: parsed };
  if (!input.destinationDbExists) return { kind: "database-missing" };
  if (input.destinationIdentity !== parsed.identity) {
    return {
      kind: "identity-mismatch",
      expected: parsed.identity,
      found: input.destinationIdentity,
    };
  }
  return { kind: "valid", marker: parsed };
}

export type MigrationProbe = {
  /** The override, already trimmed. Null when unset. */
  override: string | null;
  previousInstanceRunning: boolean;
  marker: MarkerValidity;
  previousDirectoryReadable: boolean;
  /** A database file sits at the previous location, readable or not. */
  sourceDatabasePresent: boolean;
  /** That database could actually be opened. */
  sourceDatabaseReadable: boolean;
  destinationHasDatabase: boolean;
  sourceBytes: number;
  freeBytesAtSource: number;
  freeBytesAtDestination: number;
};

export type MigrationDecision =
  | { action: "use-override"; directory: string }
  | { action: "refuse" }
  | { action: "refuse-unavailable" }
  | { action: "use-destination"; marker: MigrationMarker }
  | { action: "record-fresh-install" }
  | { action: "report-conflict" }
  | { action: "copy" }
  | { action: "fail"; reason: string };

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb)} MB` : `${bytes} bytes`;
}

/**
 * The first-launch decision, in the order the plan's flowchart fixes.
 *
 * The override comes first so a development run — which forces it precisely so
 * a working copy can run beside an installed build — is exempt from all of
 * this. The lock sits below the override and above the marker: the window worth
 * guarding is the one *after* a migration, when two live copies of the same
 * credentials exist, so checking only on the migrating launch would leave it
 * open.
 */
export function decideMigration(probe: MigrationProbe): MigrationDecision {
  if (probe.override) return { action: "use-override", directory: probe.override };

  if (probe.previousInstanceRunning) return { action: "refuse" };

  switch (probe.marker.kind) {
    case "valid":
      return { action: "use-destination", marker: probe.marker.marker };
    case "database-missing":
      return {
        action: "fail",
        reason:
          "A completed migration is recorded, but its database is missing. Refusing to start with an empty workspace.",
      };
    case "identity-mismatch":
      return {
        action: "fail",
        reason:
          "A completed migration is recorded, but the database at the new location is not the one it describes.",
      };
    case "unknown-version":
      return {
        action: "fail",
        reason: `The migration record was written by a newer version of this app (format ${probe.marker.version}). Refusing to act on it.`,
      };
    case "unparseable":
      return {
        action: "fail",
        reason: `The migration record could not be read (${probe.marker.detail}).`,
      };
    case "absent":
      break;
  }

  if (!probe.sourceDatabasePresent) {
    // Nothing to carry forward. If the previous directory is also unopenable
    // there is no fallback to fall back to, and booting into an empty workspace
    // is the outcome R11 forbids.
    if (!probe.previousDirectoryReadable) return { action: "refuse-unavailable" };
    return { action: "record-fresh-install" };
  }

  // A database is there but will not open. That is emphatically not a fresh
  // install: reporting it as one would create a second empty database beside
  // data the user still has, which is the outcome R11 forbids.
  if (!probe.sourceDatabaseReadable) {
    return {
      action: "fail",
      reason: "The previous database is present but could not be read.",
    };
  }

  if (probe.destinationHasDatabase) return { action: "report-conflict" };

  if (probe.sourceBytes > MAX_MIGRATION_SOURCE_BYTES) {
    return {
      action: "fail",
      reason: `The previous data folder holds ${formatBytes(probe.sourceBytes)}, over the ${formatBytes(MAX_MIGRATION_SOURCE_BYTES)} limit for a copy at launch.`,
    };
  }

  const required = probe.sourceBytes + MIGRATION_FREE_SPACE_HEADROOM_BYTES;
  if (probe.freeBytesAtDestination < required) {
    return {
      action: "fail",
      reason: `Not enough disk space at the new location: ${formatBytes(required)} needed, ${formatBytes(probe.freeBytesAtDestination)} free.`,
    };
  }
  // The source end needs room too: taking the exclusive lock opens the previous
  // database read-write, which can rewrite its sidecars.
  if (probe.freeBytesAtSource < MIGRATION_FREE_SPACE_HEADROOM_BYTES) {
    return {
      action: "fail",
      reason: `Not enough disk space at the previous location: ${formatBytes(MIGRATION_FREE_SPACE_HEADROOM_BYTES)} needed, ${formatBytes(probe.freeBytesAtSource)} free.`,
    };
  }

  return { action: "copy" };
}

/** The message shown when there is no directory left to fall back to. */
export function previousDirectoryUnavailableMessage(input: {
  previousDir: string;
  destinationDir: string;
}): string {
  return [
    `${USER_DATA_DIR_NAME} cannot open its data folder.`,
    `The previous folder ${input.previousDir} could not be read, and no data has been carried forward to ${input.destinationDir}.`,
    `Starting anyway would present an empty workspace, so it is refusing instead.`,
    `Restore access to the previous folder, or set ${USER_DATA_DIR_ENV_VAR} to an absolute path holding your data.`,
  ].join("\n");
}

/**
 * Has the previous application been used since the migration?
 *
 * Compares the newest modification time *and* the total size across the
 * previous database and its write-ahead log. The log is what matters: writes
 * land there, so the database file alone can sit unchanged for weeks while the
 * previous install is in daily use.
 *
 * Reported once per occurrence — the caller advances the baseline, so the next
 * quiet launch says nothing.
 */
export function detectPreviousStoreDivergence(
  baseline: PreviousStoreStamp | null,
  observed: PreviousStoreStamp | null,
): { diverged: boolean; nextBaseline: PreviousStoreStamp | null } {
  if (!baseline || !observed) return { diverged: false, nextBaseline: baseline };
  const diverged =
    observed.newestMtimeMs > baseline.newestMtimeMs || observed.totalBytes !== baseline.totalBytes;
  return { diverged, nextBaseline: diverged ? observed : baseline };
}
