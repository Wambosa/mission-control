// Which discretionary buttons the session (terminal) pane header shows. Both
// also have keyboard shortcuts, so users who lean on the hotkeys can hide them
// for a cleaner header. The header carries nothing else: a session is dismissed
// from the session list or the close shortcut, not from the pane itself.

export const SESSION_HEADER_BUTTON_KEYS = ["rename", "focus"] as const;

export type SessionHeaderButtonKey = (typeof SESSION_HEADER_BUTTON_KEYS)[number];

export type SessionHeaderButtonVisibility = Record<SessionHeaderButtonKey, boolean>;

export const DEFAULT_SESSION_HEADER_BUTTON_VISIBILITY: SessionHeaderButtonVisibility = {
  rename: true,
  focus: true,
};

/**
 * Coerce an arbitrary stored/received value into a complete visibility map,
 * merging any recognized boolean keys over the defaults. Unknown keys and
 * non-boolean values are ignored so a stale or partial payload degrades to the
 * defaults rather than throwing.
 */
export function normalizeSessionHeaderButtonVisibility(
  value: unknown,
): SessionHeaderButtonVisibility {
  const next: SessionHeaderButtonVisibility = { ...DEFAULT_SESSION_HEADER_BUTTON_VISIBILITY };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of SESSION_HEADER_BUTTON_KEYS) {
      if (typeof record[key] === "boolean") next[key] = record[key];
    }
  }
  return next;
}
