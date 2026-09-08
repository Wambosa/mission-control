import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  OWNER_ONLY_FILE,
  buildDiagnosticsManifest,
  stageDiagnosticsBundle,
  transcriptFileName,
  type RetainedTranscript,
} from "../diagnostics-bundle";

let root: string;

function transcript(over: Partial<RetainedTranscript> = {}): RetainedTranscript {
  return {
    taskId: "t-1",
    title: "a session",
    projectId: "p-1",
    archived: false,
    output: "what the session printed",
    ...over,
  };
}

function writeLog(name: string, contents = "log line\n"): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, contents);
  return file;
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-diag-bundle-"));
});

describe("transcriptFileName", () => {
  it("leads with the task id so the file is unambiguous", () => {
    expect(transcriptFileName("t-1", "fix the parser")).toBe("t-1-fix-the-parser.log");
  });

  // A session title is free text and becomes a path here.
  it("strips path separators and traversal out of a title", () => {
    expect(transcriptFileName("t-1", "../../etc/passwd")).toBe("t-1-etc-passwd.log");
    expect(transcriptFileName("t-1", "a/b\\c")).toBe("t-1-a-b-c.log");
  });

  it("falls back to the id alone when a title sanitizes to nothing", () => {
    expect(transcriptFileName("t-1", "///")).toBe("t-1.log");
    expect(transcriptFileName("t-1", "")).toBe("t-1.log");
  });

  it("refuses to produce a bare traversal even from a hostile id", () => {
    expect(transcriptFileName("../..", "x")).not.toContain("..");
  });

  it("caps the length so a pasted title cannot make an unusable filename", () => {
    const name = transcriptFileName("t-1", "y".repeat(500));
    expect(name.length).toBeLessThan(140);
  });
});

describe("stageDiagnosticsBundle", () => {
  it("lays out the manifest, the logs, and the transcripts", () => {
    const dir = path.join(root, "out");
    const entries = stageDiagnosticsBundle(dir, {
      logFiles: [writeLog("main.log"), writeLog("main.old.log")],
      transcripts: [transcript()],
      manifest: { appVersion: "1.0.0" },
    });

    expect(entries).toEqual([
      "manifest.json",
      "logs/main.log",
      "logs/main.old.log",
      "transcripts/t-1-a-session.log",
    ]);
    expect(fs.readFileSync(path.join(dir, "logs/main.log"), "utf8")).toBe("log line\n");
    expect(fs.readFileSync(path.join(dir, "transcripts/t-1-a-session.log"), "utf8")).toBe(
      "what the session printed",
    );
    expect(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"))).toEqual({
      appVersion: "1.0.0",
    });
  });

  // The rotated sibling exists only once the log has rotated, so its absence is
  // the normal case rather than a failure — and the copy is attempted directly,
  // so this also covers a log that rotates away mid-export.
  it("omits a rotated log that does not exist rather than failing", () => {
    const dir = path.join(root, "out");
    const entries = stageDiagnosticsBundle(dir, {
      logFiles: [writeLog("main.log"), path.join(root, "main.old.log")],
      transcripts: [],
      manifest: {},
    });
    expect(entries).toEqual(["manifest.json", "logs/main.log"]);
  });

  it("produces a bundle of logs alone when there are no transcripts", () => {
    const dir = path.join(root, "out");
    const entries = stageDiagnosticsBundle(dir, {
      logFiles: [writeLog("main.log")],
      transcripts: [],
      manifest: {},
    });
    expect(entries).not.toContain("transcripts/");
    expect(fs.existsSync(path.join(dir, "transcripts"))).toBe(false);
  });

  it("succeeds with no logs at all, which is itself a finding worth exporting", () => {
    const dir = path.join(root, "out");
    const entries = stageDiagnosticsBundle(dir, {
      logFiles: [],
      transcripts: [transcript()],
      manifest: {},
    });
    expect(entries).toEqual(["manifest.json", "transcripts/t-1-a-session.log"]);
  });

  // R26. The bundle carries verbatim terminal output; a default-mode file in a
  // synced folder is exactly the exposure that describes.
  it("writes every staged file owner-only", () => {
    const dir = path.join(root, "out");
    stageDiagnosticsBundle(dir, {
      logFiles: [writeLog("main.log")],
      transcripts: [transcript()],
      manifest: {},
    });
    expect(mode(path.join(dir, "manifest.json"))).toBe(OWNER_ONLY_FILE);
    expect(mode(path.join(dir, "logs/main.log"))).toBe(OWNER_ONLY_FILE);
    expect(mode(path.join(dir, "transcripts/t-1-a-session.log"))).toBe(OWNER_ONLY_FILE);
  });

  it("copies a log owner-only even when the source is world-readable", () => {
    const dir = path.join(root, "out");
    const source = writeLog("main.log");
    fs.chmodSync(source, 0o644);
    stageDiagnosticsBundle(dir, { logFiles: [source], transcripts: [], manifest: {} });
    expect(mode(path.join(dir, "logs/main.log"))).toBe(OWNER_ONLY_FILE);
  });

  it("keeps two sessions that sanitize to the same name from overwriting each other", () => {
    const dir = path.join(root, "out");
    const entries = stageDiagnosticsBundle(dir, {
      logFiles: [],
      transcripts: [
        transcript({ taskId: "t-1", title: "a/b", output: "first" }),
        transcript({ taskId: "t-1", title: "a-b", output: "second" }),
      ],
      manifest: {},
    });
    const files = entries.filter((e) => e.startsWith("transcripts/"));
    expect(new Set(files).size).toBe(2);
    const contents = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).sort();
    expect(contents).toEqual(["first", "second"]);
  });

  it("writes an empty transcript rather than skipping the session", () => {
    const dir = path.join(root, "out");
    stageDiagnosticsBundle(dir, {
      logFiles: [],
      transcripts: [transcript({ output: "" })],
      manifest: {},
    });
    expect(fs.readFileSync(path.join(dir, "transcripts/t-1-a-session.log"), "utf8")).toBe("");
  });
});

describe("buildDiagnosticsManifest", () => {
  it("records the build, the platform, and what the bundle holds", () => {
    // The caller resolves which logs exist; this function does no I/O and
    // reports the list it was handed.
    const manifest = buildDiagnosticsManifest({
      appVersion: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      packaged: true,
      logFiles: [writeLog("main.log")],
      transcripts: [transcript({ output: "abc" })],
      now: Date.UTC(2026, 8, 8, 12, 0, 0),
    });

    expect(manifest).toMatchObject({
      exportedAt: "2026-09-08T12:00:00.000Z",
      appVersion: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      packaged: true,
      logFiles: ["main.log"],
      transcriptCount: 1,
      scrubbed: false,
    });
    expect(manifest.transcripts).toEqual([
      { taskId: "t-1", projectId: "p-1", archived: false, bytes: 3 },
    ]);
  });

  // KD2 ships the export unscrubbed. The artifact leaves the machine, so it
  // says so itself rather than relying on the UI that produced it.
  it("states in the artifact that it is unscrubbed", () => {
    const manifest = buildDiagnosticsManifest({
      appVersion: "1.0.0",
      platform: "darwin",
      arch: "arm64",
      packaged: false,
      logFiles: [],
      transcripts: [],
      now: 0,
    });
    expect(manifest.scrubbed).toBe(false);
    expect(String(manifest.note)).toContain("Unscrubbed");
  });

  it("does not put transcript content in the manifest, only its size", () => {
    const manifest = buildDiagnosticsManifest({
      appVersion: "1.0.0",
      platform: "darwin",
      arch: "arm64",
      packaged: false,
      logFiles: [],
      transcripts: [transcript({ output: "SECRET-TOKEN-VALUE" })],
      now: 0,
    });
    expect(JSON.stringify(manifest)).not.toContain("SECRET-TOKEN-VALUE");
  });
});
