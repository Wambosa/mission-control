import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  USER_DATA_DB_FILENAME,
  USER_DATA_DIR_ENV_VAR,
  USER_DATA_DIR_NAME,
  ensureUserDataDir,
  resolveUserDataDir,
  userDataDbPath,
} from "../user-data-paths";

// @ts-expect-error The deploy CLI is a Node .mjs script; tests exercise its exported helpers.
const remoteVm = await import("../../../scripts/remote-vm.mjs");
const remoteVmResolveUserDataDir = remoteVm.resolveUserDataDir as (
  env?: NodeJS.ProcessEnv,
  platform?: string,
  home?: string,
) => string;

const HOME = "/home/tester";
const PLATFORMS = ["darwin", "win32", "linux"] as const;

/** Re-import the schema-migration config with a stubbed platform and env. */
async function resolveDrizzleDbUrl(platform: string, env: NodeJS.ProcessEnv): Promise<string> {
  const originalPlatform = process.platform;
  // os.homedir() reads the OS environment through libuv, not the process.env
  // object, so the keys have to be mutated in place — replacing process.env
  // wholesale swaps the proxy for a plain object and homedir stops seeing it.
  const patch: Record<string, string | undefined> = {
    HOME: HOME,
    USERPROFILE: HOME,
    [USER_DATA_DIR_ENV_VAR]: env[USER_DATA_DIR_ENV_VAR],
  };
  const restore: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) restore[key] = process.env[key];
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // drizzle.config.ts resolves the directory at module scope, so the stubs have
  // to be in place before the import and the module cache has to be cleared.
  vi.resetModules();
  try {
    const mod = await import("../../../drizzle.config");
    const config = mod.default as unknown as { dbCredentials: { url: string } };
    return config.dbCredentials.url;
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    for (const [key, value] of Object.entries(restore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.resetModules();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("user-data path resolution — one module, every consumer (AE4)", () => {
  for (const platform of PLATFORMS) {
    it(`resolves the same directory on ${platform} for every consumer`, async () => {
      const env: NodeJS.ProcessEnv = {};
      const shared = resolveUserDataDir(env, platform, HOME);

      expect(shared).toContain(USER_DATA_DIR_NAME);
      expect(path.isAbsolute(shared)).toBe(true);

      // The database client re-exports the shared resolver rather than owning a copy.
      const dbClient = await import("~/db/client");
      expect(dbClient.resolveUserDataDir(env, platform, HOME)).toBe(shared);

      // The remote-VM CLI keeps its own pinned copy (KTD11) — it must agree.
      expect(remoteVmResolveUserDataDir(env, platform, HOME)).toBe(shared);

      // The schema-migration config resolves through the shared module.
      expect(await resolveDrizzleDbUrl(platform, {})).toBe(userDataDbPath(shared));
    });
  }

  it("puts the database at the same filename for every consumer", () => {
    const dir = resolveUserDataDir({}, "linux", HOME);
    expect(userDataDbPath(dir)).toBe(path.join(dir, USER_DATA_DB_FILENAME));

    // Every production consumer of the filename joins it to a directory it is
    // handed, so the agreement that matters is that none of them still carries
    // its own literal. The remote-VM CLI is the one sanctioned copy (KTD11).
    const consumers = [
      "src/db/client.ts",
      "electron/main.ts",
      "electron/api-token-store.ts",
      "electron/app-settings-store.ts",
      "electron/sandbox-store.ts",
      "electron/project-roots.ts",
      "drizzle.config.ts",
    ];
    for (const file of consumers) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source, `${file} should not carry its own database-filename literal`).not.toMatch(
        new RegExp(`["'\`]${USER_DATA_DB_FILENAME}["'\`]`),
      );
      expect(source, `${file} should not carry its own directory-name literal`).not.toMatch(
        new RegExp(`["'\`][^"'\`\n]*${USER_DATA_DIR_NAME}[^"'\`\n]*["'\`]`),
      );
    }
  });

  it("pins the remote-VM CLI's own copy to the module's constants", () => {
    const script = fs.readFileSync(path.join(process.cwd(), "scripts/remote-vm.mjs"), "utf8");
    expect(script).toContain(USER_DATA_DIR_NAME);
    expect(script).toContain(USER_DATA_DB_FILENAME);
  });
});

describe("the override variable", () => {
  it("uses the override when it is set", () => {
    const env = { [USER_DATA_DIR_ENV_VAR]: "/tmp/elsewhere" };
    expect(resolveUserDataDir(env, "darwin", HOME)).toBe("/tmp/elsewhere");
    expect(remoteVmResolveUserDataDir(env, "darwin", HOME)).toBe("/tmp/elsewhere");
  });

  it("trims a padded override", () => {
    const env = { [USER_DATA_DIR_ENV_VAR]: "  /tmp/elsewhere  " };
    expect(resolveUserDataDir(env, "darwin", HOME)).toBe("/tmp/elsewhere");
    expect(remoteVmResolveUserDataDir(env, "darwin", HOME)).toBe("/tmp/elsewhere");
  });

  it("treats a whitespace-only override as unset in every resolver", async () => {
    const env = { [USER_DATA_DIR_ENV_VAR]: "   " };
    const fallback = resolveUserDataDir({}, "darwin", HOME);

    expect(resolveUserDataDir(env, "darwin", HOME)).toBe(fallback);
    expect(remoteVmResolveUserDataDir(env, "darwin", HOME)).toBe(fallback);

    const dbClient = await import("~/db/client");
    expect(dbClient.resolveUserDataDir(env, "darwin", HOME)).toBe(fallback);

    expect(await resolveDrizzleDbUrl("darwin", { [USER_DATA_DIR_ENV_VAR]: "   " })).toBe(
      userDataDbPath(fallback),
    );
  });
});

describe("an undeterminable home directory", () => {
  it("fails with a message naming the override variable", () => {
    expect(() => resolveUserDataDir({}, "darwin", "")).toThrow(USER_DATA_DIR_ENV_VAR);
    expect(() => remoteVmResolveUserDataDir({}, "darwin", "")).toThrow(USER_DATA_DIR_ENV_VAR);
  });

  it("never returns a relative path", () => {
    expect(() => resolveUserDataDir({}, "linux", "   ")).toThrow(USER_DATA_DIR_ENV_VAR);
  });

  it("still honours the override when the home directory is unknown", () => {
    const env = { [USER_DATA_DIR_ENV_VAR]: "/tmp/rescue" };
    expect(resolveUserDataDir(env, "darwin", "")).toBe("/tmp/rescue");
    expect(remoteVmResolveUserDataDir(env, "darwin", "")).toBe("/tmp/rescue");
  });
});

describe("ensureUserDataDir", () => {
  const made: string[] = [];

  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-data-paths-"));
    made.push(dir);
    return dir;
  }

  it("creates a missing directory owner-only", () => {
    const dir = path.join(tmpDir(), "nested", USER_DATA_DIR_NAME);
    ensureUserDataDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("repairs an already-existing world-readable directory to owner-only", () => {
    const dir = path.join(tmpDir(), USER_DATA_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);

    ensureUserDataDir(dir);

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("returns the directory it ensured", () => {
    const dir = path.join(tmpDir(), USER_DATA_DIR_NAME);
    expect(ensureUserDataDir(dir)).toBe(dir);
  });
});
