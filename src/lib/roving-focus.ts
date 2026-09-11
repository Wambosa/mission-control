/**
 * Where Arrow Up / Arrow Down lands in a roving-focus menu.
 *
 * `current` is -1 when nothing in the menu holds focus yet. Arrow Down then
 * opens at the first item and Arrow Up at the last — the wrap a bare
 * `(current + delta) % count` gets wrong, landing one short of the end.
 */
export function nextRovingIndex(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}
