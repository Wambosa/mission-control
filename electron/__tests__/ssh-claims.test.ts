import { describe, expect, it, vi } from "vitest";
import { claimSshHost, listSshClaims, readSshRuntime, sshClientId, unclaimSshHost } from "../ssh-claims";
import type { SshExec } from "../ssh-exec";
import type { SettingsKV } from "../sandbox-settings";
import type { SshClaim } from "../../src/shared/ssh-claims";

const PREFIX = "/home/sam/.mission-control";
const CLIENT = "a3f1c8d20b4e5f67";

function kv(initial: Record<string, string> = {}): SettingsKV & { store: Record<string, string> } {
  const store = { ...initial };
  return {
    store,
    get: (key) => store[key] ?? null,
    set: (key, value) => {
      store[key] = value;
    },
  };
}

function exec(result: Partial<{ code: number; stdout: string; stderr: string }> = {}): {
  run: SshExec;
  scripts: string[];
} {
  const scripts: string[] = [];
  const run: SshExec = async (_args, stdin) => {
    scripts.push(stdin);
    return { code: 0, stdout: "", stderr: "", ...result };
  };
  return { run, scripts };
}

function claim(overrides: Partial<SshClaim> = {}): SshClaim {
  return {
    clientId: CLIENT,
    clientVersion: "0.49.0",
    agentVersion: "1.2.3",
    claimedAt: "2026-08-26T12:00:00.000Z",
    ...overrides,
  };
}

describe("sshClientId", () => {
  it("mints an id once and keeps it", () => {
    const store = kv();

    const first = sshClientId(store);
    const second = sshClientId(store);

    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(second).toBe(first);
  });

  it("gives two installations different names", () => {
    expect(sshClientId(kv())).not.toBe(sshClientId(kv()));
  });

  it("replaces a stored id that is not safe to use", () => {
    // A hand-edited settings row must not reach a shell or a path.
    const store = kv({ "client.instanceId": "../../etc/passwd" });

    expect(sshClientId(store)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("readSshRuntime", () => {
  const target = { platform: "linux" as const, homeDir: "/home/sam", prefix: PREFIX };

  it("reports the key and port a host is already running", async () => {
    const { run } = exec({
      stdout: 'present=1\nmanifest={"agentPort":9412,"agentVersion":"1.2.3"}\nkey=deadbeef\n',
    });

    expect(await readSshRuntime("workshop", target, run)).toEqual({
      apiKey: "deadbeef",
      manifest: { agentPort: 9412, agentVersion: "1.2.3" },
    });
  });

  it("reads a runtime that predates the manifest, so its key is still adopted", async () => {
    const { run } = exec({ stdout: "present=1\nmanifest=\nkey=deadbeef\n" });

    expect(await readSshRuntime("workshop", target, run)).toEqual({
      apiKey: "deadbeef",
      manifest: null,
    });
  });

  it("reports nothing for a host with no runtime", async () => {
    const { run } = exec({ stdout: "present=0\n" });

    expect(await readSshRuntime("workshop", target, run)).toBeNull();
  });

  it("reports nothing when the host cannot be reached", async () => {
    // The safe direction: the caller provisions rather than adopting a key it
    // never actually read.
    const { run } = exec({ code: 255, stderr: "Host key verification failed.\n" });

    expect(await readSshRuntime("workshop", target, run)).toBeNull();
  });

  it("asks in one round trip", async () => {
    const run = vi.fn<SshExec>(async () => ({ code: 0, stdout: "present=0\n", stderr: "" }));

    await readSshRuntime("workshop", target, run);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("claimSshHost", () => {
  it("writes this client's claim under the prefix", async () => {
    const { run, scripts } = exec();

    expect(await claimSshHost("workshop", PREFIX, claim(), run)).toEqual({ ok: true });
    expect(scripts[0]).toContain(`${PREFIX}/service/clients/${CLIENT}.json`);
  });

  it("reports a claim it could not write, in the host's own terms", async () => {
    const { run } = exec({ code: 1, stderr: "Read-only file system\n" });

    const result = await claimSshHost("workshop", PREFIX, claim(), run);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Read-only file system/);
  });
});

describe("unclaimSshHost", () => {
  it("reports how many claims survive this client leaving", async () => {
    const { run } = exec({ stdout: "remaining=2\n" });

    expect(await unclaimSshHost("workshop", PREFIX, CLIENT, run)).toBe(2);
  });

  it("reports zero when this client was the last one", async () => {
    const { run } = exec({ stdout: "remaining=0\n" });

    expect(await unclaimSshHost("workshop", PREFIX, CLIENT, run)).toBe(0);
  });

  it("reports unknown rather than zero when the host did not answer", async () => {
    // Removal treats unknown as "someone may still be here", so this must not
    // collapse to 0 — that would delete a prefix another client is using.
    const { run } = exec({ code: 255, stderr: "Connection timed out\n" });

    expect(await unclaimSshHost("workshop", PREFIX, CLIENT, run)).toBeNull();
  });
});

describe("listSshClaims", () => {
  it("reads every claim on the host", async () => {
    const other = claim({ clientId: "9b2e04ff1c3d5a78" });
    const { run } = exec({
      stdout: `${JSON.stringify(claim())}\n${JSON.stringify(other)}\n`,
    });

    const claims = await listSshClaims("workshop", PREFIX, run);

    expect(claims.map((c) => c.clientId)).toEqual([CLIENT, "9b2e04ff1c3d5a78"]);
  });

  it("reads an unreachable host as no claims rather than failing", async () => {
    const { run } = exec({ code: 255, stderr: "Connection refused\n" });

    expect(await listSshClaims("workshop", PREFIX, run)).toEqual([]);
  });
});
