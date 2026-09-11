import { describe, expect, it } from "vitest";
import { validateGroupName } from "../group-name";

const existing = [
  { id: "g-alpha", name: "Alpha" },
  { id: "g-beta", name: "Beta" },
];

describe("validateGroupName", () => {
  it("accepts a plain name", () => {
    expect(validateGroupName("Gamma", existing)).toEqual({ ok: true, name: "Gamma" });
  });

  it("accepts a name with surrounding whitespace and trims it", () => {
    expect(validateGroupName("  Gamma  ", existing)).toEqual({ ok: true, name: "Gamma" });
  });

  it("rejects an empty name", () => {
    const result = validateGroupName("", existing);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBeTruthy();
  });

  it("rejects a whitespace-only name", () => {
    expect(validateGroupName("   ", existing).ok).toBe(false);
  });

  it("rejects a name matching an existing group exactly", () => {
    const result = validateGroupName("Alpha", existing);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("Alpha");
  });

  it("rejects a name that duplicates an existing one only after trimming", () => {
    expect(validateGroupName("  Alpha  ", existing).ok).toBe(false);
  });

  it("lets a group keep its own name when renaming", () => {
    expect(validateGroupName("Alpha", existing, { excludeId: "g-alpha" })).toEqual({
      ok: true,
      name: "Alpha",
    });
  });

  it("still rejects renaming onto another group's name", () => {
    expect(validateGroupName("Beta", existing, { excludeId: "g-alpha" }).ok).toBe(false);
  });

  it("treats a different case as a different name, matching the existing exact-match rule", () => {
    expect(validateGroupName("alpha", existing).ok).toBe(true);
  });

  it("accepts any name when no groups exist yet", () => {
    expect(validateGroupName("First", [])).toEqual({ ok: true, name: "First" });
  });
});
