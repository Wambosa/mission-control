import { spawn as nodeSpawn } from "node:child_process";
import {
  buildSshProbeScript,
  deriveSshProvisionPlan,
  parseSshProbeOutput,
  type SshProbeOutcome,
  type SshProvisionRequirements,
} from "../src/shared/ssh-provision";
import { classifySshFailure, SSH_COMMON_OPTIONS } from "./ssh-transport";

// The look-before-you-install half of first connect. One SSH exec runs the
// read-only probe script and everything after that is a pure function of what
// it printed, so a host is never needed to reason about a provisioning plan.

export type SshExecResult = { code: number | null; stdout: string; stderr: string };

/** Run a command over SSH with a script on stdin. Injected for tests. */
export type SshExec = (args: string[], stdin: string) => Promise<SshExecResult>;

/**
 * `sh -s` reads the script from stdin, which keeps the probe out of the
 * command line entirely — no quoting to get wrong, nothing in the host's
 * process list. As with the tunnel, no flag here relaxes host-key checking.
 */
export function sshProbeArgs(alias: string): string[] {
  return ["-T", ...SSH_COMMON_OPTIONS, alias, "sh", "-s"];
}

const defaultExec: SshExec = (args, stdin) =>
  new Promise((resolve) => {
    const child = nodeSpawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => resolve({ code: null, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });

/**
 * Ask a host what it already has, then work out what it needs. A non-zero exit
 * is SSH's refusal, reported in SSH's terms rather than as a probe failure.
 */
export async function probeSshHost(
  alias: string,
  requirements: SshProvisionRequirements,
  exec: SshExec = defaultExec,
): Promise<SshProbeOutcome> {
  const result = await exec(sshProbeArgs(alias), buildSshProbeScript(requirements.harnesses));
  if (result.code !== 0) {
    return { ok: false, error: classifySshFailure(result.stderr, result.code).message };
  }
  const probe = parseSshProbeOutput(result.stdout);
  return { ok: true, probe, plan: deriveSshProvisionPlan(probe, requirements) };
}
