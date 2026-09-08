/**
 * Staging for the diagnostics export bundle (KTD7, R26).
 *
 * The export is a bundle rather than a copy of the log file, because the
 * transcripts that make a dead-session postmortem possible live in the database
 * — an export limited to logs would still leave the reader needing SQL, which
 * is the exact gap this work closes for prompts.
 *
 * This module lays the bundle out on disk and has no electron dependency, so
 * the layout and the file modes are testable. Archiving and the save dialog
 * stay in main.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type RetainedTranscript = {
  taskId: string;
  title: string;
  projectId: string;
  archived: boolean;
  output: string;
};

export type DiagnosticsBundleInput = {
  /** Absolute paths to log files. Missing ones are skipped, not fatal. */
  logFiles: readonly string[];
  transcripts: readonly RetainedTranscript[];
  manifest: Record<string, unknown>;
};

/** Owner-only, for both the staging tree and the bundle it becomes. */
export const OWNER_ONLY_FILE = 0o600;
export const OWNER_ONLY_DIR = 0o700;

/**
 * A stable, safe filename for one session's transcript.
 *
 * The task id leads so the file is unambiguous and sorts with its session; the
 * title follows because an id alone tells the reader nothing. Everything
 * outside a conservative set is replaced — a session title is free text and
 * ends up as a path here.
 */
export function transcriptFileName(taskId: string, title: string): string {
  const safeId = sanitizeSegment(taskId) || "unknown";
  const safeTitle = sanitizeSegment(title);
  return safeTitle ? `${safeId}-${safeTitle}.log` : `${safeId}.log`;
}

function sanitizeSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
}

/**
 * Lay the bundle out under `dir` and return the entries created, relative to
 * `dir` — which is what the archiver needs.
 *
 * Every write is owner-only. The bundle carries verbatim terminal history:
 * whatever a shell or agent ever printed, including file contents that were
 * displayed, environment dumps, and pasted secrets. A default-mode file in a
 * synced folder is exactly the exposure that describes.
 */
export function stageDiagnosticsBundle(dir: string, input: DiagnosticsBundleInput): string[] {
  fs.mkdirSync(dir, { recursive: true, mode: OWNER_ONLY_DIR });
  const entries: string[] = [];

  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(input.manifest, null, 2)}\n`, {
    mode: OWNER_ONLY_FILE,
  });
  entries.push("manifest.json");

  const logsDir = path.join(dir, "logs");
  let wroteLog = false;
  for (const source of input.logFiles) {
    const name = path.basename(source);
    const target = path.join(logsDir, name);
    if (!wroteLog) {
      fs.mkdirSync(logsDir, { recursive: true, mode: OWNER_ONLY_DIR });
      wroteLog = true;
    }
    try {
      // Copied rather than pre-checked: a log can rotate away between the
      // caller resolving the list and this copy, and a rotated sibling that is
      // simply absent is the normal case rather than a failure.
      fs.copyFileSync(source, target);
    } catch {
      continue;
    }
    fs.chmodSync(target, OWNER_ONLY_FILE);
    entries.push(path.posix.join("logs", name));
  }

  if (input.transcripts.length > 0) {
    const transcriptsDir = path.join(dir, "transcripts");
    fs.mkdirSync(transcriptsDir, { recursive: true, mode: OWNER_ONLY_DIR });
    const used = new Set<string>();
    for (const transcript of input.transcripts) {
      let name = transcriptFileName(transcript.taskId, transcript.title);
      // Two sessions can sanitize to the same name; a collision must not make
      // one silently overwrite the other.
      let suffix = 2;
      while (used.has(name)) {
        name = transcriptFileName(transcript.taskId, `${transcript.title}-${suffix}`);
        suffix += 1;
      }
      used.add(name);
      fs.writeFileSync(path.join(transcriptsDir, name), transcript.output, {
        mode: OWNER_ONLY_FILE,
      });
      entries.push(path.posix.join("transcripts", name));
    }
  }

  return entries;
}

/** What the manifest records about a bundle. */
export function buildDiagnosticsManifest(input: {
  appVersion: string;
  platform: string;
  arch: string;
  packaged: boolean;
  /** Already resolved to the files that exist; this function does no I/O. */
  logFiles: readonly string[];
  transcripts: readonly RetainedTranscript[];
  now: number;
}): Record<string, unknown> {
  return {
    exportedAt: new Date(input.now).toISOString(),
    appVersion: input.appVersion,
    platform: input.platform,
    arch: input.arch,
    packaged: input.packaged,
    logFiles: input.logFiles.map((file) => path.basename(file)),
    transcriptCount: input.transcripts.length,
    transcripts: input.transcripts.map((t) => ({
      taskId: t.taskId,
      projectId: t.projectId,
      archived: t.archived,
      bytes: Buffer.byteLength(t.output, "utf8"),
    })),
    // Stated in the artifact itself, because the artifact leaves the machine.
    scrubbed: false,
    note:
      "Unscrubbed. Contains local paths, project names, route paths, and verbatim " +
      "terminal output, which may include file contents, environment dumps, and secrets.",
  };
}
