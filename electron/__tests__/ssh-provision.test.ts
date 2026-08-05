import { describe, expect, it, vi } from "vitest";
import {
  runSshProvision,
  sshProvisionCommands,
  type SshProvisionProgress,
} from "../ssh-provision";
import type { SshExec } from "../ssh-exec";
import type { SshProvisionPlan } from "../../src/shared/ssh-provision";

const AGENT_VERSION = "0.3.1";

function plan(overrides: Partial<SshProvisionPlan> = {}): SshProvisionPlan {
  return {
    ok: true,
    platform: "linux",
    arch: "x64",
    prefix: "/home/sam/.mission-control",
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
      expect(command.script).toContain("MC_PREFIX='/home/sam/.mission-control'");
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

    // npm's "global" is only ever global to the prefix Mission Control owns.
    const installs = scripts.match(/npm install[^\n]*/g) ?? [];
    expect(installs).not.toHaveLength(0);
    for (const install of installs) {
      expect(install).toContain(`--prefix "$MC_PREFIX"`);
    }
    expect(scripts).toContain("MC_PREFIX='/home/sam/.mission-control'");
    expect(scripts).not.toMatch(/\/usr\/local\/(lib|bin)/);
    expect(scripts).not.toMatch(/\.(bashrc|zshrc|profile|bash_profile|zprofile|zshenv)\b/);
  });

  it("quotes a home directory the user was free to name", () => {
    const awkward = scriptsFor(plan({ prefix: "/home/o'brien/my dir/.mission-control" }));

    expect(awkward).toContain(`MC_PREFIX='/home/o'\\''brien/my dir/.mission-control'`);
  });

  it("derives every host path from the SSH user's home directory", () => {
    const elsewhere = scriptsFor(plan({ platform: "darwin", prefix: "/Users/ada/.mission-control" }));

    expect(elsewhere).toContain("/Users/ada/.mission-control");
    expect(elsewhere).not.toContain("/home/sam");
    // Absolute paths that are not the prefix belong to the host, not to us.
    for (const path of elsewhere.match(/(?<=')\/[^']*(?=')/g) ?? []) {
      expect(path.startsWith("/Users/ada/.mission-control")).toBe(true);
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

describe("runSshProvision", () => {
  it("runs every step in order and reports the prefix it laid down", async () => {
    const { run, scripts } = exec([{ code: 0 }]);
    const steps: SshProvisionProgress[] = [];

    const result = await runSshProvision("workshop", plan(), {
      agentVersion: AGENT_VERSION,
      exec: run,
      onProgress: (progress) => steps.push(progress),
    });

    expect(result).toEqual({ ok: true, prefix: "/home/sam/.mission-control" });
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
