import { describe, expect, it, vi } from "vitest";
import {
  removeSshHost,
  retirePreviousSshLayout,
  runSshProvision,
  sshProvisionCommands,
  sshRemovalScript,
  type SshProvisionProgress,
} from "../ssh-provision";
import type { SshExec } from "../ssh-exec";
import type { SshProvisionPlan } from "../../src/shared/ssh-provision";

const AGENT_VERSION = "0.3.1";
const PREFIX = "/home/sam/.chaos-wrangler";

function plan(overrides: Partial<SshProvisionPlan> = {}): SshProvisionPlan {
  return {
    ok: true,
    platform: "linux",
    arch: "x64",
    prefix: "/home/sam/.chaos-wrangler",
    steps: [
      { kind: "runtime", reason: "missing", presentVersion: null },
      { kind: "agent", reason: "missing", presentVersion: null },
    ],
    ...overrides,
  };
}

function scriptsFor(target: SshProvisionPlan = plan()): string {
  return sshProvisionCommands(target, { agentVersion: AGENT_VERSION })
    .map((command) => command.script)
    .join("\n");
}

function exec(results: Array<{ code: number; stdout?: string; stderr?: string }>): {
  run: SshExec;
  scripts: string[];
} {
  const scripts: string[] = [];
  let call = 0;
  const run: SshExec = async (_args, stdin) => {
    scripts.push(stdin);
    const result = results[call] ?? results.at(-1) ?? { code: 0 };
    call += 1;
    return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { run, scripts };
}

describe("sshProvisionCommands", () => {
  it("installs both the runtime and the agent under the prefix (AE1)", () => {
    const commands = sshProvisionCommands(plan(), { agentVersion: AGENT_VERSION });

    expect(commands.map((c) => c.id)).toEqual(["prefix", "runtime", "agent"]);
    // Each script binds the prefix once and refers to it from there on.
    for (const command of commands) {
      expect(command.script).toContain("MC_PREFIX='/home/sam/.chaos-wrangler'");
    }
    const runtime = commands.find((c) => c.id === "runtime")!.script;
    expect(runtime).toContain("node-v24");
    expect(runtime).toContain("linux-x64");
    expect(runtime).toContain('"$MC_PREFIX/runtime"');
    const agent = commands.find((c) => c.id === "agent")!.script;
    expect(agent).toContain(`@agentsystemlabs/mission-control-agent@${AGENT_VERSION}`);
    expect(agent).toContain(`--prefix "$MC_PREFIX"`);
  });

  it("makes the PTY helper executable, which the published tarball leaves unset", () => {
    const agent = sshProvisionCommands(plan(), { agentVersion: AGENT_VERSION }).find(
      (c) => c.id === "agent",
    )!.script;

    expect(agent).toMatch(/spawn-helper.*chmod \+x|chmod \+x.*spawn-helper/s);
  });

  it("proves the agent can open a PTY before calling the host provisioned", () => {
    const agent = sshProvisionCommands(plan(), { agentVersion: AGENT_VERSION }).find(
      (c) => c.id === "agent",
    )!.script;

    expect(agent).toContain("node-pty");
    expect(agent).toContain(".spawn(");
    expect(agent).toMatch(/exit 1/);
  });

  it("omits the steps the host already satisfies", () => {
    const commands = sshProvisionCommands(plan({ steps: [] }), { agentVersion: AGENT_VERSION });

    expect(commands.map((c) => c.id)).toEqual(["prefix"]);
  });

  it("leaves harness steps to harness provisioning", () => {
    const commands = sshProvisionCommands(
      plan({ steps: [{ kind: "harness", agent: "codex" }] }),
      { agentVersion: AGENT_VERSION },
    );

    expect(commands.map((c) => c.id)).toEqual(["prefix"]);
  });

  it("never emits sudo", () => {
    expect(scriptsFor()).not.toMatch(/\bsudo\b/);
  });

  it("never installs globally or writes to a shell configuration file", () => {
    const scripts = scriptsFor();

    // npm's "global" is only ever global to the prefix Chaos Wrangler owns.
    const installs = scripts.match(/npm install[^\n]*/g) ?? [];
    expect(installs).not.toHaveLength(0);
    for (const install of installs) {
      expect(install).toContain(`--prefix "$MC_PREFIX"`);
    }
    expect(scripts).toContain("MC_PREFIX='/home/sam/.chaos-wrangler'");
    expect(scripts).not.toMatch(/\/usr\/local\/(lib|bin)/);
    expect(scripts).not.toMatch(/\.(bashrc|zshrc|profile|bash_profile|zprofile|zshenv)\b/);
  });

  it("quotes a home directory the user was free to name", () => {
    const awkward = scriptsFor(plan({ prefix: "/home/o'brien/my dir/.chaos-wrangler" }));

    expect(awkward).toContain(`MC_PREFIX='/home/o'\\''brien/my dir/.chaos-wrangler'`);
  });

  it("derives every host path from the SSH user's home directory", () => {
    const elsewhere = scriptsFor(plan({ platform: "darwin", prefix: "/Users/ada/.chaos-wrangler" }));

    expect(elsewhere).toContain("/Users/ada/.chaos-wrangler");
    expect(elsewhere).not.toContain("/home/sam");
    // Absolute paths that are not the prefix belong to the host, not to us.
    for (const path of elsewhere.match(/(?<=')\/[^']*(?=')/g) ?? []) {
      expect(path.startsWith("/Users/ada/.chaos-wrangler")).toBe(true);
    }
  });

  it("fetches a build matching the host's platform and architecture", () => {
    const macArm = scriptsFor(plan({ platform: "darwin", arch: "arm64" }));

    expect(macArm).toContain("darwin-arm64");
    expect(macArm).not.toContain("linux-x64");
  });

  it("verifies the runtime download against the checksums it publishes", () => {
    expect(scriptsFor()).toMatch(/SHASUMS256\.txt/);
  });
});

describe("sshRemovalScript", () => {
  const script = () => sshRemovalScript({ platform: "linux", homeDir: "/home/sam", prefix: PREFIX });
  const macScript = () =>
    sshRemovalScript({ platform: "darwin", homeDir: "/Users/ada", prefix: "/Users/ada/.mc" });

  it("unregisters the service before deleting what it points at", () => {
    const text = script();
    const unregister = text.indexOf("systemctl --user disable");
    const remove = text.indexOf(`rm -rf '${PREFIX}'`);

    expect(unregister).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(-1);
    expect(unregister).toBeLessThan(remove);
  });

  it("unloads the LaunchAgent before deleting what it points at", () => {
    const text = macScript();

    expect(text.indexOf("launchctl")).toBeLessThan(text.indexOf("rm -rf '/Users/ada/.mc'"));
  });

  it("deletes the unit file too, which lives outside the prefix", () => {
    expect(script()).toContain("/home/sam/.config/systemd/user/chaos-wrangler-agent.service");
    expect(macScript()).toContain("/Users/ada/Library/LaunchAgents/com.shondiaz.chaoswrangler.agent.plist");
  });

  it("never touches the user's SSH config", () => {
    for (const text of [script(), macScript()]) {
      expect(text).not.toMatch(/\.ssh\b/);
      expect(text).not.toMatch(/ssh[_/]config/);
      expect(text).not.toMatch(/known_hosts|authorized_keys/);
    }
  });

  it("never asks for root and deletes nothing but its own directory", () => {
    for (const text of [script(), macScript()]) {
      expect(text).not.toMatch(/\bsudo\b/);
      for (const target of text.match(/rm -rf [^\n]*/g) ?? []) {
        expect(target).toMatch(/\.chaos-wrangler|\.mc|LaunchAgents|systemd\/user/);
      }
    }
  });

  it("finishes even when the service was never registered", () => {
    // Removal has to work on a host that failed halfway through provisioning.
    expect(script()).not.toContain("set -e\n");
    expect(script()).toMatch(/\|\| true/);
  });
});

describe("removeSshHost", () => {
  const target = { platform: "linux" as const, homeDir: "/home/sam", prefix: PREFIX };

  it("reports a host it fully cleaned up", async () => {
    const { run, scripts } = exec([{ code: 0 }]);

    const result = await removeSshHost("workshop", target, { exec: run });

    expect(result).toEqual({ ok: true });
    expect(scripts).toHaveLength(1);
  });

  it("still succeeds for an unreachable host, naming what it left behind", async () => {
    const { run } = exec([{ code: 255, stderr: "ssh: connect to host workshop port 22: No route to host\n" }]);

    const result = await removeSshHost("workshop", target, { exec: run });

    // The local record goes either way — the caller must not be blocked from
    // forgetting a host it can no longer reach.
    expect(result.ok).toBe(true);
    expect(result.ok && result.leftBehind).toMatchObject({ prefix: PREFIX });
    expect(result.ok && result.leftBehind?.reason).toMatch(/could not reach|unreachable/i);
  });

  it("names the leftovers when the host answers but cleanup fails", async () => {
    const { run } = exec([{ code: 1, stderr: "rm: cannot remove: Permission denied\n" }]);

    const result = await removeSshHost("workshop", target, { exec: run });

    expect(result.ok).toBe(true);
    expect(result.ok && result.leftBehind?.reason).toMatch(/Permission denied/);
  });

  it("touches only the host it was asked about", async () => {
    const { run, scripts } = exec([{ code: 0 }]);

    await removeSshHost("workshop", target, { exec: run });

    expect(scripts[0]).toContain(PREFIX);
    expect(scripts[0]).not.toContain("/home/other");
  });
});

describe("runSshProvision", () => {
  it("runs every step in order and reports the prefix it laid down", async () => {
    const { run, scripts } = exec([{ code: 0 }]);
    const steps: SshProvisionProgress[] = [];

    const result = await runSshProvision("workshop", plan(), {
      agentVersion: AGENT_VERSION,
      exec: run,
      onProgress: (progress) => steps.push(progress),
    });

    expect(result).toEqual({ ok: true, prefix: "/home/sam/.chaos-wrangler" });
    expect(scripts).toHaveLength(3);
    expect(steps.filter((s) => s.status === "done").map((s) => s.command.id)).toEqual([
      "prefix",
      "runtime",
      "agent",
    ]);
    expect(steps.every((s) => s.total === 3)).toBe(true);
  });

  it("stops at the first failing step and names it", async () => {
    const { run } = exec([{ code: 0 }, { code: 1, stderr: "curl: (6) could not resolve host\n" }]);
    const steps: SshProvisionProgress[] = [];

    const result = await runSshProvision("workshop", plan(), {
      agentVersion: AGENT_VERSION,
      exec: run,
      onProgress: (progress) => steps.push(progress),
    });

    expect(result).toMatchObject({ ok: false, failedStep: "runtime" });
    expect(result.ok === false && result.error).toMatch(/could not resolve host/);
    expect(steps.at(-1)).toMatchObject({ status: "failed", command: { id: "runtime" } });
    // The agent step never ran.
    expect(steps.some((s) => s.command.id === "agent")).toBe(false);
  });

  it("surfaces an SSH refusal in SSH's terms rather than as an install failure", async () => {
    const { run } = exec([{ code: 255, stderr: "Host key verification failed.\n" }]);

    const result = await runSshProvision("workshop", plan(), {
      agentVersion: AGENT_VERSION,
      exec: run,
    });

    expect(result.ok === false && result.error).toMatch(
      /will not accept a host key on your behalf/i,
    );
  });

  it("touches the host once per step and no more", async () => {
    const run = vi.fn<SshExec>(async () => ({ code: 0, stdout: "", stderr: "" }));

    await runSshProvision("workshop", plan({ steps: [] }), {
      agentVersion: AGENT_VERSION,
      exec: run,
    });

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("retirePreviousSshLayout (R14, R21, R22, R26, AE14, AE16)", () => {
  const TARGET = {
    platform: "linux" as const,
    homeDir: "/home/sam",
    previousPrefix: "/home/sam/.mission-control",
  };

  /** An exec that answers each call in turn and records what it was given. */
  function scripted(
    replies: Array<Partial<{ code: number; stdout: string; stderr: string }>>,
  ): { run: SshExec; scripts: string[] } {
    const scripts: string[] = [];
    let call = 0;
    const run: SshExec = async (_args, stdin) => {
      scripts.push(stdin);
      const reply = replies[call++] ?? {};
      return { code: 0, stdout: "", stderr: "", ...reply };
    };
    return { run, scripts };
  }

  it("stops the previous service, then removes its layout (AE14)", async () => {
    const { run, scripts } = scripted([{}, {}]);

    const result = await retirePreviousSshLayout("host", TARGET, { exec: run });

    expect(result).toEqual({ ok: true, removed: true });
    expect(scripts).toHaveLength(2);
    // Order is the point: the stop is confirmed before anything is deleted.
    expect(scripts[0]).toContain("systemctl --user stop mission-control-agent.service");
    expect(scripts[0]).toContain("is-active --quiet mission-control-agent.service");
    expect(scripts[1]).toContain(`rm -rf '/home/sam/.mission-control'`);
    expect(scripts[1]).toContain("mission-control-agent.service");
  });

  it("does not remove anything when the stop cannot be confirmed (R26)", async () => {
    // The agent holds its key in memory, so deleting its directory would revoke
    // nothing while leaving the app believing the host was retired.
    const { run, scripts } = scripted([{ code: 1, stderr: "previous service is still active" }]);

    const result = await retirePreviousSshLayout("host", TARGET, { exec: run });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.agentUnrevoked).toBe(true);
      expect(result.error).toContain("Stopping the previous agent service");
    }
    expect(scripts).toHaveLength(1);
    expect(scripts.some((s) => s.includes("rm -rf"))).toBe(false);
  });

  it("retains a host another client still claims, and deletes nothing (AE16)", async () => {
    // With several installs sharing one host this is the expected path. The
    // previous directory stays, and so does an agent this app cannot revoke.
    const { run, scripts } = scripted([{ stdout: "remaining=2\n" }]);

    const result = await retirePreviousSshLayout("host", TARGET, {
      exec: run,
      clientId: "client-a",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.removed).toBe(false);
      expect("retained" in result && result.retained.reason).toBeTruthy();
    }
    expect(scripts.some((s) => s.includes("rm -rf"))).toBe(false);
    expect(scripts.some((s) => s.includes("is-active"))).toBe(false);
  });

  it("proceeds once this client's claim was the last one", async () => {
    const { run } = scripted([{ stdout: "remaining=0\n" }, {}, {}]);

    const result = await retirePreviousSshLayout("host", TARGET, {
      exec: run,
      clientId: "client-a",
    });

    expect(result).toEqual({ ok: true, removed: true });
  });

  it("reports the host unchanged when the removal itself fails", async () => {
    // Not agentless: the service is confirmed stopped, so nothing is serving —
    // but the directory is still there, and the record must not advance.
    const { run } = scripted([{}, { code: 1, stderr: "permission denied" }]);

    const result = await retirePreviousSshLayout("host", TARGET, { exec: run });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.agentUnrevoked).toBe(false);
      expect(result.error).toContain("Removing the previous layout");
    }
  });

  it("refuses a teardown target that is not named after the previous prefix", async () => {
    const { run, scripts } = scripted([{}, {}]);

    for (const previousPrefix of ["", "   ", "/home/sam", ".mission-control", "/"]) {
      const result = await retirePreviousSshLayout(
        "host",
        { ...TARGET, previousPrefix },
        { exec: run },
      );
      expect(result.ok, previousPrefix).toBe(false);
      if (!result.ok) expect(result.error).toContain("absolute path");
    }
    // Nothing was even attempted against the host.
    expect(scripts).toHaveLength(0);
  });

  it("quotes a home directory containing a space and an apostrophe", async () => {
    const { run, scripts } = scripted([{}, {}]);
    const home = "/home/o'brien/my dir";

    await retirePreviousSshLayout(
      "host",
      { platform: "linux", homeDir: home, previousPrefix: `${home}/.mission-control` },
      { exec: run },
    );

    expect(scripts[1]).toContain(`rm -rf '/home/o'\\''brien/my dir/.mission-control'`);
  });

  it("uses launchd on macOS and never mentions systemd", async () => {
    const { run, scripts } = scripted([{}, {}]);

    await retirePreviousSshLayout(
      "host",
      {
        platform: "darwin",
        homeDir: "/Users/ada",
        previousPrefix: "/Users/ada/.mission-control",
      },
      { exec: run },
    );

    expect(scripts[0]).toContain("launchctl bootout gui/$(id -u)/com.mission-control.agent");
    expect(scripts[0]).toContain("launchctl print gui/$(id -u)/com.mission-control.agent");
    expect(scripts[0]).not.toContain("systemctl");
    expect(scripts[1]).toContain("Library/LaunchAgents/com.mission-control.agent.plist");
    expect(scripts[1]).not.toContain("systemctl");
  });

  it("is idempotent against a host whose previous layout is already gone", async () => {
    // Absence reads as stopped, and each removal step is non-strict, so a
    // second run over the same host reports the same success.
    const { run } = scripted([{}, {}]);
    const first = await retirePreviousSshLayout("host", TARGET, { exec: run });
    const second = await retirePreviousSshLayout("host", TARGET, { exec: run });

    expect(first).toEqual({ ok: true, removed: true });
    expect(second).toEqual({ ok: true, removed: true });
  });

  it("leaves the upstream agent binary name out of the teardown", async () => {
    // The binary differs from the previous prefix by one suffix, and it is the
    // upstream vendor's published name — a teardown must not target it.
    const { run, scripts } = scripted([{}, {}]);
    await retirePreviousSshLayout("host", TARGET, { exec: run });

    for (const script of scripts) {
      expect(script).not.toContain("rm -rf '/home/sam/.mission-control/bin/mission-control-agent'");
    }
  });
});
