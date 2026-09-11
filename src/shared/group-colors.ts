/**
 * The group palette and the rule for picking from it.
 *
 * Lives in `shared` because both sides need the same answer: the server
 * assigns a new group's color, and the client predicts that same value for
 * its optimistic row so the dot does not change color on reconcile. Two
 * hand-kept copies of the formula would drift.
 */
export const GROUP_COLORS = [
  "#ff5a1f",
  "#8ab4ff",
  "#c792ea",
  "#ff9466",
  "#f472b6",
  "#34d399",
  "#fb923c",
];

/** The color a group gets when nobody picks one: the palette cycled by count. */
export function nextGroupColor(existingCount: number): string {
  return GROUP_COLORS[existingCount % GROUP_COLORS.length] ?? "#ff5a1f";
}
