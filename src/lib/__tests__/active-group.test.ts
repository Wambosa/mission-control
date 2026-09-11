import { describe, expect, it } from "vitest";
import type { Group } from "~/db/schema";
import {
  ACTIVE_GROUP_ALL,
  ACTIVE_GROUP_UNGROUPED,
  ALL_GROUPS_LABEL,
  activeGroupLabel,
  buildGroupScopeEntries,
} from "../active-group";

function group(id: string, name: string, color = "#7aa2f7"): Group {
  return { id, name, color, sortOrder: 0, createdAt: 0 };
}

const alpha = group("g-alpha", "Alpha");
const beta = group("g-beta", "Beta", "#f7768e");

describe("activeGroupLabel", () => {
  it("names the all-scope key 'All groups'", () => {
    expect(activeGroupLabel(ACTIVE_GROUP_ALL, [alpha])).toBe("All groups");
  });

  it("names a real group by its own name", () => {
    expect(activeGroupLabel("g-alpha", [alpha, beta])).toBe("Alpha");
  });

  it("falls back to the all-scope wording for a group id that no longer exists", () => {
    expect(activeGroupLabel("g-deleted", [alpha])).toBe(ALL_GROUPS_LABEL);
  });

  it("still names the Ungrouped bucket", () => {
    expect(activeGroupLabel(ACTIVE_GROUP_UNGROUPED, [alpha])).toBe("Ungrouped");
  });
});

describe("buildGroupScopeEntries", () => {
  const projects = [
    { groupId: "g-alpha" },
    { groupId: "g-alpha" },
    { groupId: "g-beta" },
    { groupId: null },
  ];

  it("carries no count on the all-scope entry and a count on every group entry", () => {
    const entries = buildGroupScopeEntries({
      groups: [alpha, beta],
      projects,
      activeGroup: ACTIVE_GROUP_ALL,
    });

    const all = entries.find((e) => e.key === ACTIVE_GROUP_ALL);
    expect(all?.count).toBeNull();
    expect(all?.label).toBe(ALL_GROUPS_LABEL);

    expect(entries.find((e) => e.key === "g-alpha")?.count).toBe(2);
    expect(entries.find((e) => e.key === "g-beta")?.count).toBe(1);
  });

  it("keeps the count on the Ungrouped entry", () => {
    const entries = buildGroupScopeEntries({
      groups: [alpha, beta],
      projects,
      activeGroup: ACTIVE_GROUP_ALL,
    });

    expect(entries.find((e) => e.key === ACTIVE_GROUP_UNGROUPED)?.count).toBe(1);
  });

  it("omits the Ungrouped entry when nothing is ungrouped and it is not the active scope", () => {
    const entries = buildGroupScopeEntries({
      groups: [alpha],
      projects: [{ groupId: "g-alpha" }],
      activeGroup: ACTIVE_GROUP_ALL,
    });

    expect(entries.some((e) => e.key === ACTIVE_GROUP_UNGROUPED)).toBe(false);
  });

  it("keeps the Ungrouped entry visible while it is the active scope, even at zero", () => {
    const entries = buildGroupScopeEntries({
      groups: [alpha],
      projects: [{ groupId: "g-alpha" }],
      activeGroup: ACTIVE_GROUP_UNGROUPED,
    });

    expect(entries.find((e) => e.key === ACTIVE_GROUP_UNGROUPED)?.count).toBe(0);
  });

  it("derives the all-scope label from the shared helper, so surfaces cannot disagree", () => {
    const entries = buildGroupScopeEntries({
      groups: [alpha],
      projects,
      activeGroup: ACTIVE_GROUP_ALL,
    });

    expect(entries[0]?.label).toBe(activeGroupLabel(ACTIVE_GROUP_ALL, [alpha]));
  });

  it("lets a surface tint the all-scope entry without changing its wording", () => {
    const tinted = buildGroupScopeEntries({
      groups: [alpha],
      projects,
      activeGroup: ACTIVE_GROUP_ALL,
      allColor: "var(--text-faint)",
    });
    const untinted = buildGroupScopeEntries({
      groups: [alpha],
      projects,
      activeGroup: ACTIVE_GROUP_ALL,
    });

    expect(tinted[0]?.color).toBe("var(--text-faint)");
    expect(untinted[0]?.color).toBeNull();
    expect(tinted[0]?.label).toBe(untinted[0]?.label);
  });

  it("orders the entries all-scope first, then groups in the order given", () => {
    const entries = buildGroupScopeEntries({
      groups: [beta, alpha],
      projects,
      activeGroup: ACTIVE_GROUP_ALL,
    });

    expect(entries.map((e) => e.key)).toEqual([
      ACTIVE_GROUP_ALL,
      "g-beta",
      "g-alpha",
      ACTIVE_GROUP_UNGROUPED,
    ]);
  });
});
