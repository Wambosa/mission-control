import { describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("electron-log/main", () => ({ default: logMock }));
vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.0", isPackaged: false },
  dialog: {},
  shell: {},
}));

import { exportOutcome, TRANSCRIPT_FETCH_TIMEOUT_MS } from "../diagnostics-handlers";

/**
 * These three branches were unreachable from a test while they lived in
 * main.ts. They are the ones worth pinning: R27 wants a failed write surfaced
 * rather than silent, a dismissed dialog is not a failure, and a bundle that
 * lost its transcripts must not read as a plain success.
 */
describe("exportOutcome", () => {
  it("reports a saved bundle", () => {
    expect(exportOutcome({ cancelled: false, filePath: "/tmp/b.tgz", entries: 4 })).toEqual({
      ok: true,
      path: "/tmp/b.tgz",
      entries: 4,
    });
  });

  it("treats a dismissed save dialog as cancelled, not failed", () => {
    expect(exportOutcome({ cancelled: true })).toEqual({ ok: false, cancelled: true });
  });

  it("treats a missing destination as cancelled", () => {
    expect(exportOutcome({ cancelled: false, filePath: null })).toEqual({
      ok: false,
      cancelled: true,
    });
  });

  // R27: a write that fails after the destination was chosen must say so.
  it("reports a failed write as an error, distinctly from a cancel", () => {
    const out = exportOutcome({
      cancelled: false,
      filePath: "/tmp/b.tgz",
      error: new Error("EACCES"),
    });
    expect(out).toMatchObject({ ok: false });
    expect(out).not.toMatchObject({ cancelled: true });
    expect("error" in out && out.error).toContain("EACCES");
  });

  // The finding this closes: a bundle saved without transcripts previously
  // reported plain success, so an operator could not tell it apart from
  // "no sessions retained anything".
  it("still succeeds when transcripts could not be collected, but says so", () => {
    const out = exportOutcome({
      cancelled: false,
      filePath: "/tmp/b.tgz",
      entries: 2,
      transcriptsUnavailable: "http-503",
    });
    expect(out).toEqual({
      ok: true,
      path: "/tmp/b.tgz",
      entries: 2,
      transcriptsUnavailable: "http-503",
    });
  });

  it("omits the unavailable marker entirely on a clean export", () => {
    const out = exportOutcome({ cancelled: false, filePath: "/tmp/b.tgz", entries: 1 });
    expect("transcriptsUnavailable" in out).toBe(false);
  });

  it("prefers the cancel branch when both a cancel and an error are present", () => {
    // A user dismissing the dialog must never surface as an error.
    expect(exportOutcome({ cancelled: true, error: new Error("boom") })).toEqual({
      ok: false,
      cancelled: true,
    });
  });
});

describe("transcript fetch bound", () => {
  it("bounds the loopback fetch, matching the sweep elsewhere in main", () => {
    expect(TRANSCRIPT_FETCH_TIMEOUT_MS).toBe(5_000);
  });
});
