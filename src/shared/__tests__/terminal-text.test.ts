import { describe, expect, it } from "vitest";
import {
  TERMINAL_TAIL_SCAN_CAP,
  extractTerminalTail,
  stripTerminalControlText,
} from "~/shared/terminal-text";

describe("stripTerminalControlText", () => {
  it("removes colour escape sequences", () => {
    expect(stripTerminalControlText("\x1b[31mred\x1b[0m text")).toBe("red text");
  });

  it("removes operating-system command sequences", () => {
    expect(stripTerminalControlText("\x1b]0;a window title\x07after")).toBe("after");
  });

  it("removes device-control strings", () => {
    expect(stripTerminalControlText("before\x1bP1$r0m\x1b\\after")).toBe("beforeafter");
  });

  it("removes stray control bytes", () => {
    expect(stripTerminalControlText("a\x00b\x07c\x7fd")).toBe("abcd");
  });

  it("removes the colour-query reply a terminal echoes back", () => {
    expect(stripTerminalControlText("11;rgb:1c1c/1c1c/1c1c ready")).toBe(" ready");
  });

  it("leaves ordinary text alone", () => {
    expect(stripTerminalControlText("plain output, 42%")).toBe("plain output, 42%");
  });
});

describe("extractTerminalTail", () => {
  it("returns the legible lines of a tail", () => {
    expect(extractTerminalTail("first line\nsecond line\n")).toBe("first line\nsecond line");
  });

  it("strips escape sequences from what it returns", () => {
    const tail = extractTerminalTail("\x1b[32mreading\x1b[0m /Users/me/Documents/vault\n");
    expect(tail).toBe("reading /Users/me/Documents/vault");
    expect(tail).not.toContain("\x1b");
  });

  it("resolves a carriage-return-rewritten progress line to its final content", () => {
    // The raw bytes hold every frame the bar drew; only the last was on screen.
    expect(extractTerminalTail("10%\r45%\r99% done\n")).toBe("99% done");
  });

  it("truncates to the scan cap before stripping", () => {
    const noise = "x".repeat(TERMINAL_TAIL_SCAN_CAP * 2);
    const tail = extractTerminalTail(`${noise}\nthe last line\n`)!;
    expect(tail).toContain("the last line");
    expect(tail.length).toBeLessThanOrEqual(TERMINAL_TAIL_SCAN_CAP);
  });

  it("returns nothing rather than an empty-looking string when nothing legible survives", () => {
    // A full-screen TUI's last kilobytes are cursor addressing and repaint
    // fragments. Reporting that as absent beats rendering noise as evidence.
    expect(extractTerminalTail("\x1b[2J\x1b[H\x1b[38;5;240m│  │\x1b[0m\n╰────╯\n")).toBeNull();
    expect(extractTerminalTail("")).toBeNull();
    expect(extractTerminalTail("   \n\t\n")).toBeNull();
  });

  it("collapses runs of spacing without joining separate lines", () => {
    expect(extractTerminalTail("a     b\nc\t\td\n")).toBe("a b\nc d");
  });

  it("keeps only the most recent lines", () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const tail = extractTerminalTail(many)!;
    expect(tail).toContain("line 39");
    expect(tail).not.toContain("line 0\n");
    expect(tail.split("\n").length).toBeLessThanOrEqual(12);
  });
});
