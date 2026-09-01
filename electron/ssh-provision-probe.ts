import {
  buildSshProbeScript,
  deriveSshProvisionPlan,
  parseSshProbeOutput,
  type SshProbeOutcome,
  type SshProvisionRequirements,
} from "../src/shared/ssh-provision";
import { defaultSshExec, sshShellArgs, type SshExec } from "./ssh-exec";
import { classifySshFailure } from "./ssh-transport";

// The look-before-you-install half of first connect. One SSH exec runs the
// read-only probe script and everything after that is a pure function of what
// it printed, so a host is never needed to reason about a provisioning plan.

export type { SshExec, SshExecResult } from "./ssh-exec";

/** The probe is an ordinary one-shot shell command; see {@link sshShellArgs}. */
export const sshProbeArgs = sshShellArgs;

/**
 * Ask a host what it already has, then work out what it needs. A non-zero exit
 * is SSH's refusal, reported in SSH's terms rather than as a probe failure.
 */
export async function probeSshHost(
  alias: string,
  requirements: SshProvisionRequirements,
  exec: SshExec = defaultSshExec,
): Promise<SshProbeOutcome> {
  const result = await exec(sshProbeArgs(alias), buildSshProbeScript(requirements.harnesses));
  if (result.code !== 0) {
    return { ok: false, error: classifySshFailure(result.stderr, result.code).message };
  }
  const probe = parseSshProbeOutput(result.stdout);
  return { ok: true, probe, plan: deriveSshProvisionPlan(probe, requirements) };
}
