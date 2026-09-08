import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IPC } from "../ipc-channels";

/**
 * The diagnostics channels are registered through the safe wrapper, which is
 * what rejects a call from a frame the app does not own.
 *
 * A source-level assertion in the same shape as the packaging-config and
 * api-auth dispatch-wrapper guards. It catches the regression that matters: a
 * channel added with a bare ipcMain.handle bypasses the frame gate entirely,
 * and nothing else in the suite would notice. The handlers live in
 * diagnostics-handlers.ts, read once because several assertions use it.
 */
const HANDLERS = fs.readFileSync(
  path.resolve(__dirname, "..", "diagnostics-handlers.ts"),
  "utf8",
);

const DIAGNOSTICS_CHANNELS = [
  "diagnosticsExport",
  "diagnosticsRevealLogs",
  "diagnosticsLogDirectory",
] as const;

describe("diagnostics IPC channels", () => {
  it("declares each channel exactly once, under a diagnostics namespace", () => {
    const values = DIAGNOSTICS_CHANNELS.map((key) => IPC[key]);
    expect(values).toEqual([
      "diagnostics:export",
      "diagnostics:revealLogs",
      "diagnostics:logDirectory",
    ]);
    expect(new Set(values).size).toBe(values.length);
  });

  for (const channel of DIAGNOSTICS_CHANNELS) {
    it(`registers ${channel} through safeHandle`, () => {
      expect(HANDLERS).toContain(`safeHandle(IPC.${channel}`);
    });

    it(`does not register ${channel} with a bare ipcMain.handle`, () => {
      expect(HANDLERS).not.toContain(`ipcMain.handle(IPC.${channel}`);
    });
  }

  it("bridges every channel into the renderer, so none is registered but unreachable", () => {
    const preload = fs.readFileSync(path.resolve(__dirname, "..", "preload.ts"), "utf8");
    for (const channel of DIAGNOSTICS_CHANNELS) {
      expect(preload).toContain(`IPC.${channel}`);
    }
  });

  it("types every bridged call in the renderer contract, which is hand-mirrored", () => {
    const contract = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "src", "shared", "electron-contract.ts"),
      "utf8",
    );
    expect(contract).toContain("diagnostics: {");
    expect(contract).toContain("revealLogs:");
    expect(contract).toContain("logDirectory:");
    expect(contract).toContain("DiagnosticsExportResult");
  });
});
