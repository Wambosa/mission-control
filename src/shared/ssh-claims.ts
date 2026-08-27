import { shellQuote } from "./ssh-provision";

// A host's runtime is shared. Two Mission Controls — a second machine, a dev
// build beside an installed one — reach the same SSH user, and before this
// module the second one to arrive silently took the first one's host away
// from it: a fresh API key overwrote the one the first still held, and
// removing the host deleted a prefix the first was still using.
//
// The fix is not to give each client its own runtime. `ssh-service-unit.ts`
// already says the runtime belongs to the host's own service manager rather
// than to whoever provisioned it, and that is the right relationship — one
// node process per host user, not one per client. What was missing is that
// provisioning only ever wrote. It never read back what was already there.
//
// So a client that finds a healthy runtime adopts it, and leaves a claim
// saying so. Removal takes back only that claim; the runtime goes when the
// last claim does.
//
// Claims are one file per client rather than one shared list, which is what
// makes this safe without a lock: two clients arriving together write two
// different paths, and neither has to read the other's file to write its own.

/** Directory under the prefix holding one file per client. */
export const SSH_CLAIMS_DIR = "service/clients";

/**
 * A client id names a file and is interpolated into a shell script, so it is
 * held to an alphabet that cannot mean anything in either. Generated ids are
 * hex; this is the gate that keeps a hand-edited one honest.
 */
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;

export function isValidSshClientId(value: string): boolean {
  return CLIENT_ID_PATTERN.test(value);
}

/** What one client records about its use of a host. */
export type SshClaim = {
  clientId: string;
  /** Mission Control's version, so a stale claim can be read by a human. */
  clientVersion: string;
  /** The agent version this client expects to speak to. */
  agentVersion: string;
  /** ISO 8601, UTC. */
  claimedAt: string;
};

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

export function sshClaimsDir(prefix: string): string {
  return `${trimTrailingSlash(prefix)}/${SSH_CLAIMS_DIR}`;
}

export function sshClaimPath(prefix: string, clientId: string): string {
  if (!isValidSshClientId(clientId)) throw new Error(`Unsafe SSH client id: ${clientId}`);
  return `${sshClaimsDir(prefix)}/${clientId}.json`;
}

export function renderSshClaim(claim: SshClaim): string {
  return `${JSON.stringify(claim, null, 2)}\n`;
}

/** Tolerant on purpose: a claim we cannot read still counts as someone here. */
export function parseSshClaim(text: string): SshClaim | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const clientId = typeof record.clientId === "string" ? record.clientId : "";
    if (!isValidSshClientId(clientId)) return null;
    return {
      clientId,
      clientVersion: typeof record.clientVersion === "string" ? record.clientVersion : "",
      agentVersion: typeof record.agentVersion === "string" ? record.agentVersion : "",
      claimedAt: typeof record.claimedAt === "string" ? record.claimedAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * Record this client's claim. Writing the file *is* the claim — there is no
 * list to append to, so this cannot race another client doing the same thing
 * at the same moment.
 */
export function sshClaimScript(prefix: string, claim: SshClaim): string {
  const dir = shellQuote(sshClaimsDir(prefix));
  const file = shellQuote(sshClaimPath(prefix, claim.clientId));
  return [
    "set -eu",
    `mkdir -p ${dir}`,
    `chmod 700 ${dir} 2>/dev/null || true`,
    // Written whole, then moved into place, so a reader never sees half a claim.
    `cat > ${file}.tmp <<'MC_CLAIM_EOF'`,
    renderSshClaim(claim).trimEnd(),
    "MC_CLAIM_EOF",
    `mv ${file}.tmp ${file}`,
    "",
  ].join("\n");
}

/**
 * Give up this client's claim and say what is left. The count on stdout is
 * what removal reads to decide whether the runtime still has a tenant — it is
 * emitted after the delete, so the client asking is never counted.
 */
export function sshUnclaimScript(prefix: string, clientId: string): string {
  const dir = shellQuote(sshClaimsDir(prefix));
  const file = shellQuote(sshClaimPath(prefix, clientId));
  return [
    "set -u",
    `rm -f ${file} || true`,
    // `ls` on a missing directory is an error, not an empty list; a prefix that
    // was never claimed reads as zero rather than failing the removal.
    `if [ -d ${dir} ]; then`,
    `  printf 'remaining=%s\\n' "$(find ${dir} -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"`,
    "else",
    `  printf 'remaining=0\\n'`,
    "fi",
    "",
  ].join("\n");
}

/** Read the count `sshUnclaimScript` reported. Unreadable output means unknown. */
export function parseSshRemainingClaims(stdout: string): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^remaining=(\d+)$/.exec(line.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * List the claims on a host, this client's included. Each line is one claim's
 * JSON, flattened, so the whole set comes back in a single round trip.
 */
export function sshListClaimsScript(prefix: string): string {
  const dir = shellQuote(sshClaimsDir(prefix));
  return [
    "set -u",
    `if [ -d ${dir} ]; then`,
    `  for f in ${dir}/*.json; do`,
    `    [ -f "$f" ] || continue`,
    `    tr -d '\\n' < "$f"; printf '\\n'`,
    "  done",
    "fi",
    "",
  ].join("\n");
}

export function parseSshClaimList(stdout: string): SshClaim[] {
  const claims: SshClaim[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const claim = parseSshClaim(line);
    if (claim) claims.push(claim);
  }
  return claims;
}

/** Claims held by anyone other than the client asking. */
export function otherSshClaims(claims: readonly SshClaim[], clientId: string): SshClaim[] {
  return claims.filter((claim) => claim.clientId !== clientId);
}

/**
 * What removal should tell the user, given what the host said was left after
 * this client's claim went. A host still claimed keeps its runtime — the local
 * record goes either way, because forgetting a host is this client's business
 * alone.
 *
 * A null count is the host declining to answer, and it is deliberately treated
 * like a surviving claim: refusing to delete something that might still be in
 * use is recoverable, and deleting it is not.
 */
export function describeRetainedHost(remaining: number | null): string | null {
  if (remaining === null) {
    return "Mission Control could not tell whether another Mission Control still uses this host, so it left the host untouched.";
  }
  if (remaining <= 0) return null;
  const who = remaining === 1 ? "another Mission Control" : `${remaining} other Mission Controls`;
  return `Mission Control stayed installed on this host: ${who} still uses it. Its runtime was left running.`;
}
