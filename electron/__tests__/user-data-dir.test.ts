import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { configureUserDataDir, migrationNotice, type AppSurface } from "../user-data-dir";
import type { MigrationInput, MigrationReport } from "../user-data-migration";
import { USER_DATA_DIR_ENV_VAR, USER_DATA_DIR_NAME } from "../../src/shared/user-data-paths";
import { PREVIOUS_USER_DATA_DIR_ENV_VAR } from "../../src/shared/user-data-migration";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-data-dir-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Recorded = { names: string[]; paths: Array<[string, string]> };

function appSurface(): { app: AppSurface; recorded: Recorded } {
  const recorded: Recorded = { names: [], paths: [] };
  return {
    recorded,
    app: {
      setName: (name) => recorded.names.push(name),
      setPath: (name, value) => recorded.paths.push([name, value]),
      getVersion: () => "1.2.3",
    },
  };
}

function report(overrides: Partial<MigrationReport> = {}): MigrationReport {
  return {
    outcome: "migrated",
    directory: "/new/ChaosWrangler",
    refusal: null,
    skipped: [],
    detail: "",
    divergence: false,
    previousDir: "/prev/MissionControl",
    destinationDir: "/new/ChaosWrangler",
    ...overrides,
  };
}

describe("configureUserDataDir", () => {
  it("hands the migration the previous and the new directory", () => {
    const { app } = appSurface();
    const seen: MigrationInput[] = [];
    const destination = path.join(tmpDir(), USER_DATA_DIR_NAME);
    const previous = path.join(tmpDir(), "MissionControl");

    configureUserDataDir({
      app,
      env: {
        HOME: os.homedir(),
        [USER_DATA_DIR_ENV_VAR]: destination,
        [PREVIOUS_USER_DATA_DIR_ENV_VAR]: previous,
      },
      runMigration: (input) => {
        seen.push(input);
        return report({ directory: destination, destinationDir: destination });
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].previousDir).toBe(previous);
    expect(seen[0].destinationDir).toBe(destination);
    expect(seen[0].appVersion).toBe("1.2.3");
  });

  it("sets the app name and the platform path to the resolved directory", () => {
    const { app, recorded } = appSurface();
    const destination = path.join(tmpDir(), USER_DATA_DIR_NAME);
    const env: NodeJS.ProcessEnv = { HOME: os.homedir() };

    const setup = configureUserDataDir({
      app,
      env,
      runMigration: () => report({ directory: destination, destinationDir: destination }),
    });

    expect(setup.directory).toBe(destination);
    expect(recorded.names).toEqual([USER_DATA_DIR_NAME]);
    expect(recorded.paths).toEqual([["userData", destination]]);
    expect(env[USER_DATA_DIR_ENV_VAR]).toBe(destination);
    expect(fs.existsSync(destination)).toBe(true);
  });

  it("exports the previous directory to children on the fallback path (AE10)", () => {
    // The enforcement for R11 is the single resolved value: on the failure path
    // every consumer, the server child included, must resolve the previous
    // directory — or one of them quietly bootstraps an empty database.
    const { app, recorded } = appSurface();
    const previous = path.join(tmpDir(), "MissionControl");
    fs.mkdirSync(previous, { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: os.homedir() };

    const setup = configureUserDataDir({
      app,
      env,
      runMigration: () =>
        report({
          outcome: "failed",
          directory: previous,
          previousDir: previous,
          detail: "The copy could not be verified.",
        }),
    });

    expect(setup.refused).toBe(false);
    expect(setup.directory).toBe(previous);
    expect(env[USER_DATA_DIR_ENV_VAR]).toBe(previous);
    expect(recorded.paths).toEqual([["userData", previous]]);
  });

  it("resolves the previous directory on a destination conflict too (AE17)", () => {
    const { app } = appSurface();
    const previous = path.join(tmpDir(), "MissionControl");
    fs.mkdirSync(previous, { recursive: true });
    const env: NodeJS.ProcessEnv = { HOME: os.homedir() };

    const setup = configureUserDataDir({
      app,
      env,
      runMigration: () =>
        report({ outcome: "destination-conflict", directory: previous, previousDir: previous }),
    });

    expect(setup.directory).toBe(previous);
    expect(env[USER_DATA_DIR_ENV_VAR]).toBe(previous);
  });

  it("refuses without touching the platform when a previous instance holds the data (AE18)", () => {
    const { app, recorded } = appSurface();
    const refusals: string[] = [];
    const env: NodeJS.ProcessEnv = { HOME: os.homedir() };

    const setup = configureUserDataDir({
      app,
      env,
      onRefuse: (message) => refusals.push(message),
      runMigration: () =>
        report({ outcome: "failed", refusal: "The previous version is already running." }),
    });

    expect(setup.refused).toBe(true);
    expect(refusals).toEqual(["The previous version is already running."]);
    // Nothing cached, nothing created, nothing exported.
    expect(recorded.names).toEqual([]);
    expect(recorded.paths).toEqual([]);
    expect(env[USER_DATA_DIR_ENV_VAR]).toBeUndefined();
  });

  it("does not exit on its own — the caller owns that", () => {
    const { app } = appSurface();
    expect(() =>
      configureUserDataDir({
        app,
        env: { HOME: os.homedir() },
        runMigration: () => report({ outcome: "failed", refusal: "held" }),
      }),
    ).not.toThrow();
  });

  it("passes the override through and marks it as such (AE7)", () => {
    const { app } = appSurface();
    const override = path.join(tmpDir(), "override");
    const seen: MigrationInput[] = [];

    const setup = configureUserDataDir({
      app,
      env: { HOME: os.homedir(), [USER_DATA_DIR_ENV_VAR]: override },
      runMigration: (input) => {
        seen.push(input);
        return report({ outcome: "override", directory: override, destinationDir: override });
      },
    });

    expect(seen[0].override).toBe(override);
    expect(setup.directory).toBe(override);
  });

  it("treats a blank override as unset", () => {
    const { app } = appSurface();
    const seen: MigrationInput[] = [];
    const destination = path.join(tmpDir(), USER_DATA_DIR_NAME);

    configureUserDataDir({
      app,
      env: { HOME: os.homedir(), [USER_DATA_DIR_ENV_VAR]: "   " },
      runMigration: (input) => {
        seen.push(input);
        return report({ directory: destination, destinationDir: destination });
      },
    });

    expect(seen[0].override).toBeNull();
  });
});

describe("migrationNotice", () => {
  it("reports a successful migration to the user by absolute path (AE20)", () => {
    const notice = migrationNotice(
      report({ previousDir: "/prev/MissionControl", destinationDir: "/new/ChaosWrangler" }),
    );

    expect(notice.level).toBe("info");
    expect(notice.message).toContain("/prev/MissionControl");
    expect(notice.message).toContain("/new/ChaosWrangler");
    expect(notice.message).toContain("credentials");
  });

  it("phrases the previous application conditionally, asserting nothing unchecked", () => {
    const notice = migrationNotice(report());
    // The app has not checked whether the previous application is installed, so
    // the claim has to stay conditional — never stated outright.
    expect(notice.message).toContain("If the previous application is still installed");
    expect(notice.message).not.toMatch(/The previous application is still installed/);
  });

  it("names the skipped files when some were left behind", () => {
    const notice = migrationNotice(report({ outcome: "migrated-with-skipped", skipped: [".port"] }));
    expect(notice.message).toContain(".port");
  });

  it("says nothing to the user on a fresh install, but logs it", () => {
    const notice = migrationNotice(report({ outcome: "no-previous-directory" }));
    expect(notice.message).toBeNull();
    expect(notice.event).toBe("user-data.fresh-install");
  });

  it("says nothing to the user on a quiet already-migrated launch", () => {
    const notice = migrationNotice(report({ outcome: "already-migrated" }));
    expect(notice.message).toBeNull();
  });

  it("surfaces a divergence to the user, not only to the log (AE21)", () => {
    const notice = migrationNotice(report({ outcome: "already-migrated", divergence: true }));
    expect(notice.level).toBe("warn");
    expect(notice.message).toContain("/prev/MissionControl");
    expect(notice.message).toContain("Removing the previous application");
  });

  it("surfaces a failure with both folders and the override variable (AE10)", () => {
    const notice = migrationNotice(
      report({ outcome: "failed", detail: "The copy could not be verified." }),
    );
    expect(notice.level).toBe("error");
    expect(notice.message).toContain("/prev/MissionControl");
    expect(notice.message).toContain(USER_DATA_DIR_ENV_VAR);
    expect(notice.message).toContain("intact");
  });

  it("surfaces a destination conflict as a warning that nothing was destroyed", () => {
    const notice = migrationNotice(report({ outcome: "destination-conflict" }));
    expect(notice.level).toBe("warn");
    expect(notice.message).toContain("nothing was deleted");
  });

  it("says nothing to the user when the directory came from the override", () => {
    expect(migrationNotice(report({ outcome: "override" })).message).toBeNull();
  });
});

describe("the terminal-session sanitizer (KTD13)", () => {
  it("removes the data-directory variable from an agent's environment", async () => {
    const { sanitizeEnv } = await import("../pty-manager");
    const restore = process.env[USER_DATA_DIR_ENV_VAR];
    process.env[USER_DATA_DIR_ENV_VAR] = "/somewhere/with/the/tokens";
    try {
      expect(sanitizeEnv()[USER_DATA_DIR_ENV_VAR]).toBeUndefined();
    } finally {
      if (restore === undefined) delete process.env[USER_DATA_DIR_ENV_VAR];
      else process.env[USER_DATA_DIR_ENV_VAR] = restore;
    }
  });

  it("still removes the API URL and token it was already stripping", async () => {
    const { sanitizeEnv } = await import("../pty-manager");
    const restore = { url: process.env.MC_API_URL, token: process.env.MC_API_TOKEN };
    process.env.MC_API_URL = "http://127.0.0.1:9999";
    process.env.MC_API_TOKEN = "secret";
    try {
      const env = sanitizeEnv();
      expect(env.MC_API_URL).toBeUndefined();
      expect(env.MC_API_TOKEN).toBeUndefined();
    } finally {
      for (const [key, value] of [
        ["MC_API_URL", restore.url],
        ["MC_API_TOKEN", restore.token],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
