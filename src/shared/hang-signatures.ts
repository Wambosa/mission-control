import { TERMINAL_TAIL_SCAN_CAP } from "./terminal-text";

/**
 * Known reasons a session goes quiet, declared as data.
 *
 * Adding a signature is one array element and nothing else — no branch at a
 * call site, no ordering to get right by position. That promise is only worth
 * having if an entry cannot reach for much, so the matcher is literal sets by
 * default and a pattern is the exception, permitted only where a literal cannot
 * express the case.
 *
 * Precedence is an integer on the entry, not array position: a rebase cannot
 * reorder matching, and a reviewer sees the precedence change in the diff.
 * Matching is first-match-wins, because a notification offering three competing
 * remediations is worse than one offering the wrong one.
 *
 * The fixtures live on the entries. They are what make the one-entry promise
 * real: the shape tests use them to prove a new signature matches itself, does
 * not swallow another, and has not silently disabled itself with a typo in its
 * prefilter.
 */

export type HangSignatureMatcher =
  | { readonly literals: readonly string[] }
  | { readonly pattern: RegExp };

export type HangSignatureEntry = {
  readonly id: string;
  /**
   * Lower matches first. Banded in tens so a signature can be slotted between
   * two existing ones without renumbering.
   */
  readonly priority: number;
  /**
   * A lowercase literal every real match contains, checked before the matcher
   * runs. Cheap rejection for the overwhelming majority of tails.
   */
  readonly requires: string;
  readonly match: HangSignatureMatcher;
  /** Fixed text. Never interpolates anything from the tail. */
  readonly remediation: string;
  /** A tail this entry must match, and no other entry may. */
  readonly fixture: string;
};

export const HANG_SIGNATURES = [
  {
    id: "macos-file-access",
    priority: 10,
    requires: "not permitted",
    match: { literals: ["operation not permitted"] },
    // The responsible process for a consent grant is normally the app bundle,
    // but two upstream reports describe grants keyed to an agent CLI's own
    // identity instead. Until a packaged build settles which happens here, the
    // remediation names both places the operator might have to look.
    remediation:
      "macOS is blocking access to that folder. Open Settings → Diagnostics → Folder access to grant it, then restart the session. If the folder already reads as granted there, check whether the agent's own CLI has its own entry in System Settings → Privacy & Security → Files and Folders.",
    fixture: "Error: EPERM: operation not permitted, scandir '/Users/me/Documents/vault'",
  },
  {
    id: "agent-credential-prompt",
    priority: 20,
    requires: "log in",
    match: { literals: ["please log in", "log in to continue", "you need to log in"] },
    remediation:
      "The agent is waiting for you to sign in. Open the session and complete its login prompt.",
    fixture: "Authentication expired. Please log in again to continue.",
  },
  {
    id: "folder-trust-prompt",
    priority: 30,
    requires: "trust",
    match: {
      literals: ["do you trust the files in this folder", "trust the authors of the files"],
    },
    remediation:
      "The agent is waiting on a trust prompt for this folder. Open the session and answer it.",
    fixture: "Do you trust the files in this folder? [y/N]",
  },
  {
    id: "remote-agent-unreachable",
    priority: 40,
    requires: "unreachable",
    match: {
      literals: ["container is unreachable", "agent is unreachable", "host is unreachable"],
    },
    // A container that stops responding produces exactly the silence this
    // detector sees, and naming it in data is cheaper than pre-flighting it.
    remediation:
      "The machine running this session stopped responding. Reconnect the sandbox or host, then restart the session.",
    fixture: "remote agent is unreachable (last heartbeat 4m ago)",
  },
] as const satisfies readonly HangSignatureEntry[];

export type HangSignatureId = (typeof HANG_SIGNATURES)[number]["id"];

export type HangSignatureMatch = {
  id: HangSignatureId;
  remediation: string;
};

export type HangSignatureResult = {
  match: HangSignatureMatch | null;
  /**
   * The pass ran out of time and the catalogue was not fully evaluated.
   *
   * Reported rather than swallowed: "no signature matched" and "we stopped
   * looking" are different facts, and only one of them is a bug in an entry.
   */
  degraded: boolean;
};

/**
 * How long the whole matching pass may take.
 *
 * The guardrail exists to make the pattern exception safe, not to make it the
 * norm: an input cap alone bounds only polynomial backtracking, so a badly
 * written pattern still needs a wall-clock stop. An alert must never wait on
 * the catalogue.
 */
const MATCH_DEADLINE_MS = 25;

const BY_PRIORITY = [...HANG_SIGNATURES].sort((a, b) => a.priority - b.priority);

/** Lowercase, single-spaced, capped. Entries are authored against this shape. */
export function normalizeHaystack(tail: string): string {
  const capped = tail.length > TERMINAL_TAIL_SCAN_CAP ? tail.slice(-TERMINAL_TAIL_SCAN_CAP) : tail;
  return capped.toLowerCase().replace(/\s+/g, " ");
}

function matches(entry: HangSignatureEntry, haystack: string): boolean {
  if ("literals" in entry.match) {
    return entry.match.literals.some((literal) => haystack.includes(literal));
  }
  // The entry holds one long-lived RegExp. A `g` or `y` flag would make `test`
  // advance `lastIndex` and match only every other call -- alerts losing their
  // remediation on alternating sweeps, with no error anywhere. The shape tests
  // reject those flags; this makes the object stateless regardless.
  entry.match.pattern.lastIndex = 0;
  return entry.match.pattern.test(haystack);
}

/**
 * The first signature this tail matches, by priority.
 *
 * Never throws, and never runs longer than its deadline.
 */
export function matchHangSignature(
  tail: string,
  options: { deadlineMs?: number; now?: () => number } = {},
): HangSignatureResult {
  if (!tail) return { match: null, degraded: false };

  const now = options.now ?? (() => Date.now());
  const expiresAt = now() + (options.deadlineMs ?? MATCH_DEADLINE_MS);
  const haystack = normalizeHaystack(tail);

  for (const entry of BY_PRIORITY) {
    if (now() > expiresAt) return { match: null, degraded: true };
    // The prefilter is checked before the matcher, so a pattern entry costs
    // nothing on the tails it was never going to match.
    if (!haystack.includes(entry.requires)) continue;
    try {
      if (matches(entry, haystack)) {
        return { match: { id: entry.id as HangSignatureId, remediation: entry.remediation }, degraded: false };
      }
    } catch {
      // A broken entry must not take the alert down with it.
      continue;
    }
  }

  return { match: null, degraded: now() > expiresAt };
}
