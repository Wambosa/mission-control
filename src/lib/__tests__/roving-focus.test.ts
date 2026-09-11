import { describe, expect, it } from "vitest";
import { nextRovingIndex } from "../roving-focus";

describe("nextRovingIndex", () => {
  it("moves down through the items", () => {
    expect(nextRovingIndex(0, 3, 1)).toBe(1);
    expect(nextRovingIndex(1, 3, 1)).toBe(2);
  });

  it("moves up through the items", () => {
    expect(nextRovingIndex(2, 3, -1)).toBe(1);
    expect(nextRovingIndex(1, 3, -1)).toBe(0);
  });

  it("wraps from the last item down to the first", () => {
    expect(nextRovingIndex(2, 3, 1)).toBe(0);
  });

  it("wraps from the first item up to the last", () => {
    expect(nextRovingIndex(0, 3, -1)).toBe(2);
  });

  it("opens at the first item when nothing is focused and the key is Down", () => {
    expect(nextRovingIndex(-1, 3, 1)).toBe(0);
  });

  it("opens at the LAST item when nothing is focused and the key is Up", () => {
    // The bug this pins: plain modulo arithmetic lands on count - 2 here.
    expect(nextRovingIndex(-1, 3, -1)).toBe(2);
    expect(nextRovingIndex(-1, 5, -1)).toBe(4);
  });

  it("stays put on a single item", () => {
    expect(nextRovingIndex(0, 1, 1)).toBe(0);
    expect(nextRovingIndex(0, 1, -1)).toBe(0);
  });

  it("reports no target for an empty menu", () => {
    expect(nextRovingIndex(-1, 0, 1)).toBe(-1);
    expect(nextRovingIndex(0, 0, -1)).toBe(-1);
  });
});
