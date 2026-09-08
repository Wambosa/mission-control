import { describe, expect, it } from "vitest";
import { copyText, previewText } from "../PromptSearchPalette";

/**
 * R22: copying yields the prompt's raw stored text, not the two-line clamped
 * preview the row shows.
 *
 * The row's truncation is presentational — previewText only collapses
 * whitespace, and the clamp is CSS — so copying what is displayed instead of
 * what was stored would look correct and lose content silently. These assert
 * the two are genuinely different functions, because that difference is the
 * requirement.
 */
describe("copyText", () => {
  it("returns a multi-line prompt unchanged", () => {
    const text = "first line\nsecond line\n\n  indented third";
    expect(copyText(text)).toBe(text);
  });

  it("returns a prompt far longer than the row displays, in full", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    expect(copyText(text)).toBe(text);
    expect(copyText(text).split("\n")).toHaveLength(40);
  });

  it("collapses no whitespace, which the preview does", () => {
    const text = "keep   these    spaces";
    expect(copyText(text)).toBe(text);
    expect(copyText(text)).not.toBe(previewText(text));
  });

  it("preserves leading and trailing whitespace, which the preview trims", () => {
    const text = "  padded  ";
    expect(copyText(text)).toBe(text);
    expect(previewText(text)).toBe("padded");
  });

  it("preserves tabs and newlines a shell prompt may depend on", () => {
    const text = "run:\n\tmake test\n";
    expect(copyText(text)).toBe(text);
  });

  it("differs from the preview for any multi-line input", () => {
    const text = "a\nb";
    expect(copyText(text)).not.toBe(previewText(text));
  });

  it("agrees with the preview only for text the preview would not change", () => {
    const text = "single line";
    expect(copyText(text)).toBe(previewText(text));
  });

  it("returns an empty prompt as empty rather than throwing", () => {
    expect(copyText("")).toBe("");
  });
});

describe("previewText", () => {
  // Characterizing the preview so the difference above is anchored on both
  // sides: if the preview ever stops collapsing, these tests say so rather than
  // the copy tests quietly becoming tautologies.
  it("collapses every run of whitespace to one space", () => {
    expect(previewText("a\n\nb\t\tc   d")).toBe("a b c d");
  });

  it("trims the ends", () => {
    expect(previewText("\n  text  \n")).toBe("text");
  });
});
