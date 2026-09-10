/**
 * Resolving the user-data directory at startup, migration and all.
 *
 * This lives outside the main module for one reason: the main module imports
 * the platform at top level and runs configuration at module scope, so
 * importing it under a test runner fires side effects before any assertion can
 * be made. Everything the platform provides arrives here as an injected
 * surface instead, which is what makes the ordering testable.
 *
 * The ordering itself is load-bearing and the comment block in the main module
 * documents the bug class it protects against. Three constraints stack up:
 *
 * - It must be **synchronous**. The Electron build targets CommonJS, there is
 *   no top-level await, and directory resolution is a plain module-scope
 *   expression.
 * - It must precede **any** platform path resolution. Resolving a platform path
 *   both caches a stale value and creates the directory it resolved, so the
 *   migration reads and writes paths it computes itself rather than asking the
 *   platform for them. In practice that means running before the logger
 *   initializes and before the first platform path get or set.
 * - It is the only window in which **no database connection is open**. Five
 *   connections open this database across the main process and the server
 *   child, and none exists yet at module scope.
 */

import {
  USER_DATA_DIR_ENV_VAR,
  USER_DATA_DIR_NAME,
  ensureUserDataDir,
  userDataDirOverride,
} from "../src/shared/user-data-paths";
import {
  migrationDestinationDir,
  previousUserDataDir,
} from "../src/shared/user-data-migration";
import { runUserDataMigration, type MigrationInput, type MigrationReport } from "./user-data-migration";

/** The slice of the platform's app object this needs. Injected, so testable. */
export type AppSurface = {
  setName(name: string): void;
  setPath(name: string, value: string): void;
  getVersion(): string;
};

export type UserDataDirOptions = {
  app: AppSurface;
  env?: NodeJS.ProcessEnv;
  /**
   * Called when the app must not start. Injected so a test never terminates
   * the runner — the caller is what actually exits.
   */
  onRefuse?: (message: string) => void;
  runMigration?: (input: MigrationInput) => MigrationReport;
};

export type UserDataDirSetup = {
  /** The directory this session resolved to. Every consumer uses this one. */
  directory: string;
  report: MigrationReport;
  /** True when the caller must stop starting up. */
  refused: boolean;
};

export function configureUserDataDir(options: UserDataDirOptions): UserDataDirSetup {
  const env = options.env ?? process.env;
  const migrate = options.runMigration ?? runUserDataMigration;

  const override = userDataDirOverride(env);
  const destinationDir = override ?? migrationDestinationDir(env);
  const previousDir = previousUserDataDir(env);

  const report = migrate({
    previousDir,
    destinationDir,
    override,
    appVersion: options.app.getVersion(),
  });

  if (report.refusal) {
    options.onRefuse?.(report.refusal);
    return { directory: report.directory, report, refused: true };
  }

  // On the failure and conflict paths the report resolves to the *previous*
  // directory, and that is the value exported to children — so the main
  // process and the server child cannot end up looking at different databases
  // while one of them quietly bootstraps an empty one.
  const directory = report.directory;
  ensureUserDataDir(directory);

  // Keep Electron-side IPC stores aligned with src/db/client.ts. In dev the
  // generated dist-electron/package.json only declares CommonJS, so Electron's
  // package-name-derived default can become "Electron" or "mission-control",
  // splitting API tokens and project roots across separate SQLite files.
  options.app.setName(USER_DATA_DIR_NAME);
  options.app.setPath("userData", directory);
  env[USER_DATA_DIR_ENV_VAR] = directory;

  return { directory, report, refused: false };
}

/**
 * What to log once the logger exists, and what — if anything — to put in front
 * of the user.
 *
 * Kept here rather than in the main module so the phrasing is testable. R25
 * asks for a report the user actually sees, and asks it to assert nothing the
 * app has not checked: the app does not know whether the previous application
 * is still installed, so the wording stays conditional.
 */
export function migrationNotice(report: MigrationReport): {
  level: "info" | "warn" | "error";
  event: string;
  message: string | null;
} {
  switch (report.outcome) {
    case "override":
      return { level: "info", event: "user-data.override", message: null };

    case "no-previous-directory":
      return { level: "info", event: "user-data.fresh-install", message: null };

    case "already-migrated":
      return report.divergence
        ? {
            level: "warn",
            event: "user-data.previous-store-diverged",
            message: [
              `Work has been saved into the previous data folder since this app moved to its new one.`,
              `Previous folder: ${report.previousDir}`,
              `This app cannot see that work. Removing the previous application is what ends the divergence.`,
            ].join("\n"),
          }
        : { level: "info", event: "user-data.already-migrated", message: null };

    case "migrated":
    case "migrated-with-skipped":
      return {
        level: "info",
        event: "user-data.migrated",
        message: [
          `Your data has been copied to a new folder for this release.`,
          ``,
          `New folder: ${report.destinationDir}`,
          `Previous folder, kept as a rollback: ${report.previousDir}`,
          ``,
          `The previous folder has not been changed or deleted, and it still holds saved credentials. If the previous application is still installed, launching it will write into that folder, where this app will not see it. Deleting either folder stays a manual step.`,
          ...(report.skipped.length
            ? ["", `These optional files were not carried across: ${report.skipped.join(", ")}.`]
            : []),
        ].join("\n"),
      };

    case "destination-conflict":
      return {
        level: "warn",
        event: "user-data.destination-conflict",
        message: [
          `A data folder for this release already exists, but there is no record of a completed copy.`,
          ``,
          `Nothing was copied and nothing was deleted. This session is running on the previous folder: ${report.previousDir}`,
        ].join("\n"),
      };

    case "failed":
      return {
        level: "error",
        event: "user-data.migration-failed",
        message: [
          `Your data could not be copied to the new folder for this release.`,
          ``,
          `${report.detail}`,
          ``,
          `Your work is intact and this session is using the previous folder: ${report.previousDir}`,
          `To choose a folder yourself, set ${USER_DATA_DIR_ENV_VAR} to an absolute path.`,
        ].join("\n"),
      };
  }
}
