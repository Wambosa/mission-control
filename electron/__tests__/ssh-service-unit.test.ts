import { describe, expect, it, vi } from "vitest";
import { generateSshApiKey, installSshService, sshServiceInstallScript } from "../ssh-service-unit";
import type { SshExec } from "../ssh-exec";
import type { SshServiceDescription } from "../../src/shared/ssh-service-unit";

function description(overrides: Partial<SshServiceDescription> = {}): SshServiceDescription {
  return {
    platform: "linux",
    homeDir: "/home/sam",
    prefix: "/home/sam/.mission-control",
    agentPort: 9333,
    apiKey: "b8f1c2d3e4",
    ...overrides,
  };
}

const mac = () =>
  description({ platform: "darwin", homeDir: "/Users/ada", prefix: "/Users/ada/.mission-control" });

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

describe("sshServiceInstallScript", () => {
  it("hands the unit to each platform's own service manager", () => {
    expect(sshServiceInstallScript(description())).toContain("systemctl --user enable --now");
    expect(sshServiceInstallScript(mac())).toContain("launchctl");
  });

  it("never asks for root", () => {
    for (const desc of [description(), mac()]) {
      expect(sshServiceInstallScript(desc)).not.toMatch(/\bsudo\b/);
      expect(sshServiceInstallScript(desc)).not.toMatch(/systemctl(?! --user)/);
    }
  });

  it("writes the secret-bearing file with a mode only the user can read", () => {
    const script = sshServiceInstallScript(description());

    expect(script).toContain("chmod 600 '/home/sam/.mission-control/service/agent.env'");
    expect(script).toContain("chmod 700 '/home/sam/.mission-control/service/run-agent.sh'");
  });

  it("creates the directory the service manager reads before writing into it", () => {
    const script = sshServiceInstallScript(description());
    const mkdir = script.indexOf("/home/sam/.config/systemd/user");
    const write = script.indexOf("mission-control-agent.service' <<");

    expect(mkdir).toBeGreaterThan(-1);
    expect(mkdir).toBeLessThan(write);
  });

  it("asks for lingering on Linux but does not fail without it", () => {
    const script = sshServiceInstallScript(description());

    // Guarded, so a distribution that refuses lingering does not abort the
    // registration — and either way the outcome comes back to be reported.
    expect(script).toMatch(/(if|while)[^\n]*enable-linger|enable-linger[^\n]*\|\|/);
    expect(script).toContain("mc:linger=enabled");
    expect(script).toContain("mc:linger=unavailable");
  });

  it("does not ask for lingering on macOS, which has no such thing", () => {
    expect(sshServiceInstallScript(mac())).not.toContain("enable-linger");
  });
});

describe("installSshService", () => {
  it("registers the service and reports full persistence", async () => {
    const { run, scripts } = exec({ stdout: "mc:linger=enabled\n" });

    const result = await installSshService("workshop", description(), run);

    expect(result).toEqual({
      ok: true,
      lingering: "enabled",
      unitPath: "/home/sam/.config/systemd/user/mission-control-agent.service",
    });
    expect(scripts).toHaveLength(1);
  });

  it("still registers when lingering is refused, and says persistence is reduced", async () => {
    const { run } = exec({ stdout: "mc:linger=unavailable\n" });

    const result = await installSshService("workshop", description(), run);

    expect(result).toMatchObject({ ok: true, lingering: "unavailable" });
  });

  it("reports lingering as not applicable on macOS", async () => {
    const { run } = exec();

    const result = await installSshService("workshop", mac(), run);

    expect(result).toMatchObject({ ok: true, lingering: "not-applicable" });
  });

  it("fails when the service manager refuses the unit", async () => {
    const { run } = exec({
      code: 1,
      stderr: "Failed to connect to bus: No such file or directory\n",
    });

    const result = await installSshService("workshop", description(), run);

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/Failed to connect to bus/);
  });

  it("surfaces an SSH refusal in SSH's terms", async () => {
    const { run } = exec({ code: 255, stderr: "Host key verification failed.\n" });

    const result = await installSshService("workshop", description(), run);

    expect(result.ok === false && result.error).toMatch(
      /will not accept a host key on your behalf/i,
    );
  });

  it("registers in one round trip", async () => {
    const run = vi.fn<SshExec>(async () => ({ code: 0, stdout: "", stderr: "" }));

    await installSshService("workshop", description(), run);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("generateSshApiKey", () => {
  it("mints a distinct high-entropy secret per host", () => {
    const keys = new Set(Array.from({ length: 32 }, () => generateSshApiKey()));

    expect(keys.size).toBe(32);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});
