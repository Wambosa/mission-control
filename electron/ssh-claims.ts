import { randomBytes } from "node:crypto";
import { defaultSshExec, sshShellArgs, sshStepFailure, type SshExec } from "./ssh-exec";
import type { SettingsKV } from "./sandbox-settings";
import {
  isValidSshClientId,
  parseSshClaimList,
  parseSshRemainingClaims,
  sshClaimScript,
  sshListClaimsScript,
  sshUnclaimScript,
  type SshClaim,
} from "../src/shared/ssh-claims";
import {
  parseSshRuntimeRead,
  sshRuntimeReadScript,
  type SshExistingRuntime,
  type SshServiceDescription,
} from "../src/shared/ssh-service-unit";

// The SSH half of claims: the scripts are pure and live in src/shared, the
// round trips are here. Same split the rest of the SSH work uses.

/** Where this installation's identity lives, beside the other app settings. */
const CLIENT_ID_KEY = "client.instanceId";

/**
 * A stable name for *this* Mission Control, generated once and kept. It is
 * what lets a host tell two clients apart — the desktop and the laptop, an
 * installed build and a dev build — so neither mistakes the other's runtime
 * for an orphan. Sixteen hex characters, which the shared validator accepts.
 */
export function sshClientId(kv: SettingsKV): string {
  const existing = (kv.get(CLIENT_ID_KEY) ?? "").trim();
  if (isValidSshClientId(existing)) return existing;
  const generated = randomBytes(8).toString("hex");
  kv.set(CLIENT_ID_KEY, generated);
  return generated;
}

/**
 * What runtime this host already has, if any. Its stdout carries the host's
 * bearer secret, so the result is returned to the caller and nowhere else —
 * never a progress event, never a log line. A host that cannot be reached
 * reads as "nothing there", which is the safe direction: the caller then
 * provisions rather than adopting a key it never actually read.
 */
export async function readSshRuntime(
  alias: string,
  description: Pick<SshServiceDescription, "platform" | "homeDir" | "prefix">,
  exec: SshExec = defaultSshExec,
): Promise<SshExistingRuntime | null> {
  const result = await exec(sshShellArgs(alias), sshRuntimeReadScript(description));
  if (result.code !== 0) return null;
  return parseSshRuntimeRead(result.stdout);
}

/**
 * Record that this client uses the host. Failing to claim is worth reporting
 * but not worth failing provisioning over: the runtime is up either way, and
 * an unrecorded claim costs a warning, not a broken host.
 */
export async function claimSshHost(
  alias: string,
  prefix: string,
  claim: SshClaim,
  exec: SshExec = defaultSshExec,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await exec(sshShellArgs(alias), sshClaimScript(prefix, claim));
  if (result.code !== 0) {
    return { ok: false, error: sshStepFailure("Recording this client on the host", result) };
  }
  return { ok: true };
}

/**
 * Give up this client's claim and report how many are left. A null count means
 * the host did not say — which removal must treat as "someone may still be
 * here" rather than as zero.
 */
export async function unclaimSshHost(
  alias: string,
  prefix: string,
  clientId: string,
  exec: SshExec = defaultSshExec,
): Promise<number | null> {
  const result = await exec(sshShellArgs(alias), sshUnclaimScript(prefix, clientId));
  if (result.code !== 0) return null;
  return parseSshRemainingClaims(result.stdout);
}

/** Every claim on a host, for showing the user who else is using it. */
export async function listSshClaims(
  alias: string,
  prefix: string,
  exec: SshExec = defaultSshExec,
): Promise<SshClaim[]> {
  const result = await exec(sshShellArgs(alias), sshListClaimsScript(prefix));
  if (result.code !== 0) return [];
  return parseSshClaimList(result.stdout);
}
