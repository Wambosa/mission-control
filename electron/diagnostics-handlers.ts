/**
 * Settings > Diagnostics: the export bundle and the log-folder reveal.
 *
 * A module rather than another hundred lines of main.ts, matching
 * registerPtyHandlers / registerFileHandlers / registerSandboxManager. The
 * point is not tidiness: main.ts calls app.setPath() at module scope and so
 * cannot be imported, which makes anything living there unreachable from a
 * test. Here the export's decisions are testable.
 */

import { app, dialog, shell, type BrowserWindow, type IpcMain } from "electron";
import log from "electron-log/main";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IPC } from "./ipc-channels";
import { safeHandle } from "./ipc-safe-handle";
import { getOrCreateApiToken } from "./api-token-store";
import { buildLocalMissionControlApiUrl } from "./pty-hook-env";
import {
  buildDiagnosticsManifest,
  stageDiagnosticsBundle,
  OWNER_ONLY_DIR,
  OWNER_ONLY_FILE,
  type RetainedTranscript,
} from "./diagnostics-bundle";

export type DiagnosticsDeps = {
  userDataDir: string;
  /** Read per call: the port is not known when handlers are registered. */
  runtimePort: () => number | null | undefined;
};

/**
 * How long the export waits for the server child to hand over transcripts.
 *
 * Matches the loopback-fetch bound used for the orphaned-task sweep in main.
 * Without it a server child that accepts the connection and never answers
 * stalls the export before the save dialog even opens -- an app that hangs and
 * says nothing, which is the symptom this work exists to remove.
 */
export const TRANSCRIPT_FETCH_TIMEOUT_MS = 5_000;

export type RetainedTranscriptsResult = {
  transcripts: RetainedTranscript[];
  /**
   * Why the list is empty, when it is empty because collection *failed*.
   *
   * An empty array alone cannot carry that: "no sessions retained anything"
   * and "the server child never answered" are the same value, and the second
   * is exactly the state an operator takes an export in. Reporting them
   * identically hands back a bundle that asserts zero transcripts exist.
   */
  unavailable?: string;
};

/** The log files that exist right now, current first. */
export function existingDiagnosticsLogFiles(): string[] {
  const current = log.transports.file.getFile().path;
  const dir = path.dirname(current);
  const ext = path.extname(current);
  const base = path.basename(current, ext);
  // The rotated sibling exists only once the log has rotated, so its absence
  // is the normal case. Resolved once per export and handed to both the
  // manifest and the staging step: probing separately let the two disagree if
  // a rotation landed between them.
  return [current, path.join(dir, `${base}.old${ext}`)].filter((file) => fs.existsSync(file));
}

export function diagnosticsLogDirectory(): string {
  return path.dirname(log.transports.file.getFile().path);
}

/**
 * Decide what the renderer is told after an export attempt.
 *
 * Pure, and separated from the handler because these three outcomes are the
 * part worth pinning: a cancelled save is not a failure, a failed write must
 * not read as success, and a bundle that lost its transcripts must say so
 * even though it saved.
 */
export type ExportOutcome =
  | { ok: true; path: string; entries: number; transcriptsUnavailable?: string }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled?: false; error: string };

export function exportOutcome(input: {
  cancelled: boolean;
  filePath?: string | null;
  entries?: number;
  transcriptsUnavailable?: string;
  error?: unknown;
}): ExportOutcome {
  if (input.cancelled || !input.filePath) return { ok: false, cancelled: true };
  if (input.error !== undefined) return { ok: false, error: String(input.error) };
  return {
    ok: true,
    path: input.filePath,
    entries: input.entries ?? 0,
    ...(input.transcriptsUnavailable
      ? { transcriptsUnavailable: input.transcriptsUnavailable }
      : {}),
  };
}

async function fetchRetainedTranscripts(deps: DiagnosticsDeps): Promise<RetainedTranscriptsResult> {
  // Same loopback origin and token the PTY hook environment is built from, so
  // the export reads over exactly the path capture writes over.
  const apiUrl = buildLocalMissionControlApiUrl(deps.runtimePort());
  if (!apiUrl) return { transcripts: [], unavailable: "no-api-url" };
  try {
    const res = await fetch(new URL("/api/diagnostics/transcripts", apiUrl), {
      headers: { authorization: `Bearer ${getOrCreateApiToken(deps.userDataDir)}` },
      signal: AbortSignal.timeout(TRANSCRIPT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { transcripts: [], unavailable: `http-${res.status}` };
    const body = (await res.json()) as { transcripts?: RetainedTranscript[] };
    return { transcripts: body.transcripts ?? [] };
  } catch (err) {
    // A bundle of logs alone still beats no bundle -- the server child may be
    // down, which is itself the sort of failure an export is being taken for --
    // but the bundle has to say so rather than look empty.
    return { transcripts: [], unavailable: String(err) };
  }
}

export function registerDiagnosticsHandlers(
  _ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: DiagnosticsDeps,
): void {
  safeHandle(IPC.diagnosticsLogDirectory, async () => diagnosticsLogDirectory());

  safeHandle(IPC.diagnosticsRevealLogs, async () => {
    try {
      const dir = diagnosticsLogDirectory();
      fs.mkdirSync(dir, { recursive: true });
      // openPath rather than showItemInFolder: the target is the directory
      // itself, not a file to highlight inside its parent.
      const error = await shell.openPath(dir);
      return error ? { ok: false as const, error } : { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: String(err) };
    }
  });

  safeHandle(IPC.diagnosticsExport, async () => {
    const logFiles = existingDiagnosticsLogFiles();
    const collected = await fetchRetainedTranscripts(deps);
    const transcripts = collected.transcripts;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const saveOptions = {
      title: "Export diagnostics",
      defaultPath: `mission-control-diagnostics-${stamp}.tgz`,
      filters: [{ name: "Diagnostics bundle", extensions: ["tgz"] }],
    };
    // Parented to the window when there is one, so the sheet is modal to the app.
    const win = getWin();
    const result = win
      ? await dialog.showSaveDialog(win, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (result.canceled || !result.filePath) {
      return exportOutcome({ cancelled: true });
    }

    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "mc-diagnostics-"));
    try {
      fs.chmodSync(staging, OWNER_ONLY_DIR);
      const entries = stageDiagnosticsBundle(path.join(staging, "diagnostics"), {
        logFiles,
        transcripts,
        manifest: buildDiagnosticsManifest({
          appVersion: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          packaged: app.isPackaged,
          logFiles,
          transcripts,
          transcriptsUnavailable: collected.unavailable,
          now: Date.now(),
        }),
      });

      // Create the destination owner-only BEFORE anything is written into it.
      // Opening with "w" truncates without resetting the mode, so the archive
      // never exists at default permissions even briefly -- which matters,
      // because it carries verbatim terminal output (R26).
      fs.closeSync(fs.openSync(result.filePath, "w", OWNER_ONLY_FILE));
      fs.chmodSync(result.filePath, OWNER_ONLY_FILE);

      const { create } = await import("tar");
      await create(
        { gzip: true, file: result.filePath, cwd: staging, portable: true },
        ["diagnostics"],
      );
      fs.chmodSync(result.filePath, OWNER_ONLY_FILE);

      log.info("diagnostics.exported", {
        event: "diagnostics.exported",
        entries: entries.length,
        transcripts: transcripts.length,
        transcriptsUnavailable: collected.unavailable ?? null,
      });
      return exportOutcome({
        cancelled: false,
        filePath: result.filePath,
        entries: entries.length,
        transcriptsUnavailable: collected.unavailable,
      });
    } catch (err) {
      // R27: a write that fails after the destination is chosen must say so
      // rather than looking like it worked.
      log.error("diagnostics.export.failed", {
        event: "diagnostics.export.failed",
        error: String(err),
      });
      return exportOutcome({ cancelled: false, filePath: result.filePath, error: err });
    } finally {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not worth failing the export over */
      }
    }
  });
}
