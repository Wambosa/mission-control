import { describe, expect, it, vi } from "vitest";
import { probeSshHost, sshProbeArgs, type SshExec } from "../ssh-provision-probe";
import { TASK_AGENTS } from "../../src/shared/domain";

const REQUIREMENTS = { expectedAgentVersion: "0.3.1" };

const BARE_HOST_REPORT = [
  "platform=Linux",
  "arch=x86_64",
  "home=/home/sam",
  "node=",
  "agent=",
  ...TASK_AGENTS.map((agent) => `harness.${agent}=`),
].join("\n");

function exec(result: Partial<{ code: number | null; stdout: string; stderr: string }>): {
  run: SshExec;
  calls: Array<{ args: string[]; stdin: string }>;
} {
  const calls: Array<{ args: string[]; stdin: string }> = [];
  const run: SshExec = async (args, stdin) => {
    calls.push({ args, stdin });
    return { code: 0, stdout: "", stderr: "", ...result };
  };
  return { run, calls };
}

describe("sshProbeArgs", () => {
  it("runs the script on stdin so nothing lands in the host's process list", () => {
    const args = sshProbeArgs("workshop");
    expect(args.slice(-3)).toEqual(["workshop", "sh", "-s"]);
    expect(args).toContain("BatchMode=yes");
  });

  it("never passes a flag that would accept an unknown host key", () => {
    const args = sshProbeArgs("workshop").join(" ");
    expect(args).not.toMatch(/StrictHostKeyChecking|UserKnownHostsFile/i);
  });
});

describe("probeSshHost", () => {
  it("plans everything for a host with nothing installed", async () => {
    const { run, calls } = exec({ stdout: BARE_HOST_REPORT });

    const outcome = await probeSshHost("workshop", REQUIREMENTS, run);

    expect(calls[0].stdin).toContain("uname -s");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !outcome.plan.ok) throw new Error("expected a plan");
    expect(outcome.plan.prefix).toBe("/home/sam/.mission-control");
    expect(outcome.plan.steps.map((s) => s.kind)).toEqual([
      "runtime",
      "agent",
      ...TASK_AGENTS.map(() => "harness"),
    ]);
  });

  it("reports a Windows host as unsupported rather than planning one", async () => {
    const { run } = exec({
      stdout: "platform=MINGW64_NT-10.0\narch=x86_64\nhome=/c/Users/sam\n",
    });

    const outcome = await probeSshHost("workshop", REQUIREMENTS, run);

    expect(outcome.ok && outcome.plan).toMatchObject({
      ok: false,
      reason: "unsupported-platform",
    });
  });

  it("surfaces SSH's refusal in SSH's terms when the probe cannot run", async () => {
    const { run } = exec({ code: 255, stderr: "Host key verification failed.\n" });

    const outcome = await probeSshHost("workshop", REQUIREMENTS, run);

    expect(outcome).toEqual({
      ok: false,
      error: expect.stringMatching(/will not accept a host key on your behalf/i),
    });
  });

  it("asks only about the harnesses it was told to require", async () => {
    const { run, calls } = exec({ stdout: BARE_HOST_REPORT });

    await probeSshHost("workshop", { ...REQUIREMENTS, harnesses: ["codex"] }, run);

    expect(calls[0].stdin).toContain("harness.codex");
    expect(calls[0].stdin).not.toContain("harness.opencode");
  });

  it("does not run a second command against the host", async () => {
    const run = vi.fn<SshExec>(async () => ({ code: 0, stdout: BARE_HOST_REPORT, stderr: "" }));

    await probeSshHost("workshop", REQUIREMENTS, run);

    expect(run).toHaveBeenCalledTimes(1);
  });
});
