import { describe, expect, it, vi } from "vitest";
import { buildUpdateInvocation, runAgentCliUpdate } from "../agent-cli-update";
import type { SshExec } from "../ssh-exec";

// Spawning anything locally is exactly the bug AE3 exists to catch, so the
// local spawn is watched rather than spied on after the fact.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const HOST = { kind: "ssh-host", alias: "workshop", prefix: "/home/sam/.mission-control" } as const;

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

describe("buildUpdateInvocation", () => {
  it("wraps posix commands in a shell -c invocation", () => {
    const invocation = buildUpdateInvocation("opencode upgrade", {}, "darwin");
    expect(invocation.args).toEqual(["-c", "opencode upgrade"]);
  });

  it("routes PowerShell pipelines to powershell on Windows", () => {
    const invocation = buildUpdateInvocation(
      "irm 'https://cursor.com/install?win32=true' | iex",
      { SystemRoot: "C:\\Windows" },
      "win32",
    );
    expect(invocation.file).toBe("powershell.exe");
    expect(invocation.args.at(-1)).toContain("| iex");
  });

  it("routes plain commands through cmd on Windows", () => {
    const invocation = buildUpdateInvocation(
      "npm i -g opencode-ai@latest",
      { SystemRoot: "C:\\Windows" },
      "win32",
    );
    expect(invocation.file).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.args).toEqual(["/d", "/s", "/c", "npm i -g opencode-ai@latest"]);
  });
});

describe("runAgentCliUpdate against an SSH host", () => {
  it("updates the harness on that host's prefix, not the local machine (AE3)", async () => {
    const { run, scripts } = exec({ stdout: "1.2.3\n" });

    const result = await runAgentCliUpdate("opencode", HOST, { exec: run });

    expect(result).toMatchObject({ ok: true, agent: "opencode" });
    expect(scripts.join("\n")).toContain("opencode-ai@latest");
    expect(scripts.join("\n")).toContain(`--prefix "$MC_PREFIX"`);
    expect(scripts.join("\n")).toContain("MC_PREFIX='/home/sam/.mission-control'");
  });

  it("never spawns anything locally for a host target", async () => {
    const { run } = exec({ stdout: "1.2.3\n" });
    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockClear();

    await runAgentCliUpdate("opencode", HOST, { exec: run });

    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports the version the host has after updating", async () => {
    const { run } = exec({ stdout: "1.18.14\n" });

    const result = await runAgentCliUpdate("codex", HOST, { exec: run });

    expect(result).toMatchObject({ ok: true, version: "1.18.14" });
  });

  it("surfaces the host's own output when the update fails", async () => {
    const { run } = exec({ code: 1, stderr: "npm error 403 Forbidden\n" });

    const result = await runAgentCliUpdate("codex", HOST, { exec: run });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.output).toMatch(/403 Forbidden/);
  });

  it("declines a harness it did not install on that host", async () => {
    const { run, scripts } = exec();

    // Cursor CLI has no npm package, so there is nothing in the prefix to
    // update — and updating the user's own copy is not ours to do.
    const result = await runAgentCliUpdate("cursor-cli", HOST, { exec: run });

    expect(result).toMatchObject({ ok: false, reason: "no-update-command" });
    expect(scripts).toEqual([]);
  });

  it("rejects an agent id it does not manage without touching the host", async () => {
    const { run, scripts } = exec();

    const result = await runAgentCliUpdate("not-a-harness", HOST, { exec: run });

    expect(result).toMatchObject({ ok: false, reason: "unsupported-agent" });
    expect(scripts).toEqual([]);
  });
});
