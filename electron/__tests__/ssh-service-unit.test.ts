import { describe, expect, it, vi } from "vitest";
import {
  generateSshApiKey,
  installSshService,
  sshServiceInstallScript,
  sshServiceStopScript,
  startSshService,
} from "../ssh-service-unit";
import type { SshExec } from "../ssh-exec";
import {
  previousSshLayoutRemovalScript,
  previousSshServiceStopScript,
  type SshServiceDescription,
} from "../../src/shared/ssh-service-unit";

function description(overrides: Partial<SshServiceDescription> = {}): SshServiceDescription {
  return {
    platform: "linux",
    homeDir: "/home/sam",
    prefix: "/home/sam/.chaos-wrangler",
    agentPort: 9333,
    apiKey: "b8f1c2d3e4",
    agentVersion: "1.2.3",
    ...overrides,
  };
}

const mac = () =>
  description({ platform: "darwin", homeDir: "/Users/ada", prefix: "/Users/ada/.chaos-wrangler" });

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

    expect(script).toContain("chmod 600 '/home/sam/.chaos-wrangler/service/agent.env'");
    expect(script).toContain("chmod 700 '/home/sam/.chaos-wrangler/service/run-agent.sh'");
  });

  it("creates the directory the service manager reads before writing into it", () => {
    const script = sshServiceInstallScript(description());
    const mkdir = script.indexOf("/home/sam/.config/systemd/user");
    const write = script.indexOf("chaos-wrangler-agent.service' <<");

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
      unitPath: "/home/sam/.config/systemd/user/chaos-wrangler-agent.service",
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

describe("startSshService", () => {
  it("brings a stopped runtime back on macOS without rewriting anything", async () => {
    // The stop path only unloads the unit, on the promise that connecting
    // again brings it back. Nothing kept that promise until now.
    const { run, scripts } = exec();

    const result = await startSshService("workshop", mac(), run);

    expect(result).toEqual({ ok: true });
    expect(scripts[0]).toContain("launchctl bootstrap");
    expect(scripts[0]).toContain("launchctl kickstart");
    // Restarting must not touch the env file, which holds the host's key.
    expect(scripts[0]).not.toContain("agent.env");
  });

  it("starts a stopped unit on Linux", async () => {
    const { run, scripts } = exec();

    await startSshService("workshop", description(), run);

    expect(scripts[0]).toContain("systemctl --user start chaos-wrangler-agent.service");
    expect(scripts[0]).not.toMatch(/\bsudo\b/);
  });

  it("reports a host that will not start rather than throwing", async () => {
    const { run } = exec({ code: 1, stderr: "Failed to connect to bus\n" });

    const result = await startSshService("workshop", description(), run);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/Failed to connect to bus/);
  });
});

describe("the rendered service carries the new identifiers (R12, AE6)", () => {
  it("registers under the new label and unit name", () => {
    const linux = sshServiceInstallScript(description());
    expect(linux).toContain("chaos-wrangler-agent.service");
    expect(linux).not.toContain("mission-control-agent.service");

    const macos = sshServiceInstallScript(mac());
    expect(macos).toContain("com.shondiaz.chaoswrangler.agent");
    expect(macos).not.toContain("com.mission-control.agent");
  });

  it("keeps the upstream agent binary name in the start command", () => {
    // The binary differs from the previous prefix by one suffix and is the
    // most likely thing a mechanical rewrite of this file would break. It is
    // the upstream vendor's published name: renaming it stops it resolving.
    expect(sshServiceInstallScript(description())).toContain("bin/mission-control-agent");
  });

  it("registers exactly one service", () => {
    const linux = sshServiceInstallScript(description());
    expect(linux.match(/systemctl --user enable --now/g)).toHaveLength(1);
    expect(linux.match(/chaos-wrangler-agent\.service/g)?.length).toBeGreaterThan(0);

    const macos = sshServiceInstallScript(mac());
    expect(macos.match(/launchctl bootstrap/g)).toHaveLength(1);
  });
});

describe("retiring the previous service (R14, R26)", () => {
  it("confirms the stop rather than swallowing its exit code", () => {
    const linux = previousSshServiceStopScript("linux");
    expect(linux).toContain("is-active --quiet mission-control-agent.service");
    expect(linux).toContain("exit 1");

    const macos = previousSshServiceStopScript("darwin");
    expect(macos).toContain("launchctl print gui/$(id -u)/com.mission-control.agent");
    expect(macos).toContain("exit 1");
  });

  it("treats a host that never had the previous service as stopped", () => {
    // is-active and launchctl print both exit non-zero for "not installed",
    // which is the same answer as "not running" — so no special case is needed
    // and the common second-machine path does not fail.
    for (const platform of ["linux", "darwin"] as const) {
      const script = previousSshServiceStopScript(platform);
      // The failure branch is guarded by a positive test for still-running.
      expect(script).toMatch(/if .*(is-active|launchctl print)/);
    }
  });

  it("deletes the previous unit file as well as the prefix", () => {
    const linux = previousSshLayoutRemovalScript({
      platform: "linux",
      homeDir: "/home/sam",
      previousPrefix: "/home/sam/.mission-control",
    });
    expect(linux).toContain(`rm -rf '/home/sam/.mission-control'`);
    expect(linux).toContain(
      `rm -f '/home/sam/.config/systemd/user/mission-control-agent.service'`,
    );
    expect(linux).toContain("daemon-reload");

    const macos = previousSshLayoutRemovalScript({
      platform: "darwin",
      homeDir: "/Users/ada",
      previousPrefix: "/Users/ada/.mission-control",
    });
    expect(macos).toContain(`rm -f '/Users/ada/Library/LaunchAgents/com.mission-control.agent.plist'`);
    expect(macos).not.toContain("systemctl");
  });

  it("stays non-strict per removal step, matching the existing removal path", () => {
    const script = previousSshLayoutRemovalScript({
      platform: "linux",
      homeDir: "/home/sam",
      previousPrefix: "/home/sam/.mission-control",
    });
    for (const line of script.split("\n").filter((l) => l.startsWith("rm "))) {
      expect(line.endsWith("|| true"), line).toBe(true);
    }
  });
});

describe("the idle stop covers hosts from the previous release", () => {
  it("stops both units on Linux", () => {
    const script = sshServiceStopScript(description());
    for (const unit of ["chaos-wrangler-agent.service", "mission-control-agent.service"]) {
      expect(script, unit).toContain(`systemctl --user stop ${unit}`);
    }
  });

  it("boots out both labels on macOS", () => {
    const script = sshServiceStopScript(mac());
    for (const label of ["com.shondiaz.chaoswrangler.agent", "com.mission-control.agent"]) {
      expect(script, label).toContain(`launchctl bootout gui/$(id -u)/${label}`);
    }
  });

  it("stays best-effort per step, so an absent unit does not abort the rest", () => {
    for (const script of [sshServiceStopScript(description()), sshServiceStopScript(mac())]) {
      for (const line of script.split("\n").filter(Boolean)) {
        expect(line.endsWith("|| true"), line).toBe(true);
      }
    }
  });
});
