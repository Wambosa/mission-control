/**
 * The one name rule the group surfaces share. Create and rename both run it
 * before sending, so a rejected name explains itself in the field instead of
 * failing silently or arriving at the server as a blank row.
 *
 * Exact matching only, deliberately: it mirrors the check the project dialog
 * already applies. Case and whitespace normalization is a broader change than
 * this surface should make on its own.
 */
export type GroupNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: string };

export function validateGroupName(
  raw: string,
  existing: Array<{ id: string; name: string }>,
  opts?: { excludeId?: string },
): GroupNameResult {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, reason: "A group needs a name." };

  const clash = existing.some((g) => g.id !== opts?.excludeId && g.name === name);
  if (clash) return { ok: false, reason: `A group named "${name}" already exists.` };

  return { ok: true, name };
}
