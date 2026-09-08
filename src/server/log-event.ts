/**
 * Structured events from the server child.
 *
 * The server child has no electron-log and logs with bracketed `console.*`
 * tags. Main forwards the child's stdout into the app log file, so a line
 * emitted here lands in that file already prefixed with `[server]` — and
 * adding electron-log to the child would put a second file transport on the
 * same path, which the library resolves by silently sharing one writer.
 *
 * The single-line constraint is not stylistic: main's forwarder is
 * line-oriented, so a pretty-printed payload would be shredded into unrelated
 * lines and the `{ event, ...ids }` shape destroyed. `JSON.stringify` escapes
 * newlines inside strings, so one call is always one line.
 *
 * The marker gives analysis one reliable way to separate machine events from
 * the free-text server diagnostics that remain, and from main's own
 * differently-rendered event lines:
 *
 *     rg 'mc-event' ~/Library/Logs/MissionControl/main.log
 */

export const SERVER_EVENT_MARKER = "[mc-event]";

/**
 * A logged value is capped so one oversized setting cannot flood a synchronous
 * file transport. Values this long are already unreadable in a log line, and
 * settings hold things like background-image data URLs and launcher-config
 * JSON.
 */
export const MAX_LOGGED_VALUE_CHARS = 200;

/**
 * Setting keys whose values never reach the log.
 *
 * The diagnostics export ships unscrubbed by deliberate decision, so anything
 * written here is content the operator hands to whoever they send a bundle to.
 * The database already stores the API bearer token and every sandbox pairing
 * token in cleartext; a rotation event must not copy them into a second file
 * with a wider audience. The key still gets an event — that a secret rotated
 * is exactly the kind of fact a postmortem wants — with both values replaced.
 *
 * Matched on substrings rather than an exact list so a key added later is
 * redacted by default rather than by remembering to update this.
 */
const SENSITIVE_KEY_PARTS = [
  "token",
  "secret",
  "password",
  "passphrase",
  "credential",
  "api_key",
  "apikey",
  "private_key",
] as const;

export function isSensitiveSettingKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => lower.includes(part));
}

/** The redacted, length-capped form of a setting value for a log event. */
export function settingValueForLog(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (isSensitiveSettingKey(key)) return "[redacted]";
  if (typeof value !== "string") return value;
  if (value.length <= MAX_LOGGED_VALUE_CHARS) return value;
  return `${value.slice(0, MAX_LOGGED_VALUE_CHARS)}…(${value.length} chars)`;
}

/** One structured event line: the marker, then `{ event, ...ids }` as JSON. */
export function formatServerEvent(
  event: string,
  fields: Record<string, unknown> = {},
): string {
  return `${SERVER_EVENT_MARKER} ${JSON.stringify({ event, ...fields })}`;
}

/**
 * Emit one structured event.
 *
 * Never throws: an event is diagnostic, and a payload holding something
 * JSON.stringify refuses (a circular object, a bigint) must not take down the
 * mutation that emitted it.
 */
export function logServerEvent(event: string, fields: Record<string, unknown> = {}): void {
  try {
    console.log(formatServerEvent(event, fields));
  } catch {
    try {
      console.log(`${SERVER_EVENT_MARKER} {"event":${JSON.stringify(event)},"unloggable":true}`);
    } catch {
      /* stdout is gone; a lost event must not break the caller */
    }
  }
}
