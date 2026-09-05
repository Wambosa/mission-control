/**
 * Shift+Enter in a session on an SSH host.
 *
 * Claude Code only treats ESC+CR (`\x1b\r`, what `terminal-keymap.ts` emits
 * for Shift+Enter) as "insert newline" when `shiftEnterKeyBindingInstalled` is
 * set in its settings. `electron/pty-manager.ts` writes that flag on this
 * machine, which is why a local session has always worked and a session on a
 * host has not: the agent runs on the host, reading the settings file there.
 *
 * This is the same guard aimed at the host, over the remote fs RPC the sandbox
 * agent already exposes. Doing it at session start rather than at provisioning
 * time keeps it idempotent, self-healing when the host's settings file is
 * replaced, and true for hosts provisioned before any of this existed.
 */

type RemoteFsMethod = "fs.read" | "fs.write";

export type RemoteFsRpc = (
  method: RemoteFsMethod,
  params: Record<string, unknown>,
  opts?: { timeoutMs?: number },
) => Promise<unknown>;

/**
 * A session start waits on this, so it gets its own budget rather than the
 * client's default. Two round trips at the default would let an unresponsive
 * host hold a terminal closed for a minute over a keybinding.
 */
const SHIFT_ENTER_RPC_TIMEOUT_MS = 3_000;

const SHIFT_ENTER_FLAG = "shiftEnterKeyBindingInstalled";

function claudeSettingsPath(homeDir: string): string {
  const base = homeDir.endsWith("/") ? homeDir.slice(0, -1) : homeDir;
  return `${base}/.claude/settings.json`;
}

type ReadOutcome =
  | { state: "settings"; settings: Record<string, unknown>; mtimeMs: number | null }
  /** No file yet — a fresh one carrying only the flag is the right write. */
  | { state: "absent" }
  /** Present but not something we can safely merge into. Leave it alone. */
  | { state: "unusable" };

function interpretRead(result: unknown): ReadOutcome {
  const r = result as
    | { ok?: boolean; kind?: string; content?: unknown; mtimeMs?: unknown; error?: unknown }
    | null
    | undefined;
  if (!r || typeof r !== "object") return { state: "unusable" };
  if (r.ok !== true) {
    // Any failure that is not "there is no such file" might be a file we
    // simply could not read this time; overwriting it would lose settings.
    return typeof r.error === "string" && /not[- ]?found|enoent|no such file/i.test(r.error)
      ? { state: "absent" }
      : { state: "unusable" };
  }
  if (r.kind !== "text" || typeof r.content !== "string") return { state: "unusable" };
  const mtimeMs = typeof r.mtimeMs === "number" ? r.mtimeMs : null;
  if (!r.content.trim()) return { state: "settings", settings: {}, mtimeMs };
  try {
    const parsed = JSON.parse(r.content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "unusable" };
    return { state: "settings", settings: parsed as Record<string, unknown>, mtimeMs };
  } catch {
    // Malformed JSON is the user's file in a state we did not create. Rewriting
    // it would be destroying settings to fix a keybinding.
    return { state: "unusable" };
  }
}

/**
 * Set the flag in the host user's Claude settings, unless it is already set or
 * the file is in a state we should not rewrite. Never throws: a session must
 * not fail to start over a keybinding.
 */
export async function ensureRemoteClaudeShiftEnterBinding(
  rpc: RemoteFsRpc,
  homeDir: string,
): Promise<void> {
  if (!homeDir.trim()) return;
  const settingsPath = claudeSettingsPath(homeDir);
  try {
    const outcome = interpretRead(
      await rpc("fs.read", { path: settingsPath }, { timeoutMs: SHIFT_ENTER_RPC_TIMEOUT_MS }),
    );
    if (outcome.state === "unusable") return;
    const settings = outcome.state === "settings" ? outcome.settings : {};
    if (settings[SHIFT_ENTER_FLAG] === true) return;
    const next = { ...settings, [SHIFT_ENTER_FLAG]: true };
    await rpc(
      "fs.write",
      {
        path: settingsPath,
        content: `${JSON.stringify(next, null, 2)}\n`,
        expectedMtimeMs: outcome.state === "settings" ? outcome.mtimeMs : null,
      },
      { timeoutMs: SHIFT_ENTER_RPC_TIMEOUT_MS },
    );
  } catch {
    // Best-effort, exactly like the local writer: the operator can still run
    // `/terminal-setup` on the host.
  }
}
