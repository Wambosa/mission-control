import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  removeAgentMemoryFile,
  supportsMemoryInjection,
  writeAgentMemoryFile,
} from "../agent-memory-file";

function makeDir(prefix = "mc-memfile-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}

const BRIEF = "# Project memory\n\n## Overview\n- **A test project**";

describe("agent-memory-file writer", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = makeDir();
  });

  it("reports which agents support injection (Claude only in Phase 1)", async () => {
    expect(supportsMemoryInjection("claude-code")).toBe(true);
    expect(supportsMemoryInjection("codex")).toBe(false);
    expect(supportsMemoryInjection(undefined)).toBe(false);
  });

  it("writes a marker-delimited block into CLAUDE.local.md", async () => {
    const wrote = await writeAgentMemoryFile("claude-code", cwd, BRIEF);
    expect(wrote).toBe(true);
    const content = fs.readFileSync(path.join(cwd, "CLAUDE.local.md"), "utf8");
    expect(content).toContain("<!-- mc:recall:start");
    expect(content).toContain("<!-- mc:recall:end -->");
    expect(content).toContain("A test project");
  });

  it("is idempotent — rewriting replaces the block, never duplicates it", async () => {
    await writeAgentMemoryFile("claude-code", cwd, BRIEF);
    await writeAgentMemoryFile("claude-code", cwd, "# Project memory\n\n## Overview\n- **Updated**");
    const content = fs.readFileSync(path.join(cwd, "CLAUDE.local.md"), "utf8");
    expect(content.match(/mc:recall:start/g)).toHaveLength(1);
    expect(content).toContain("Updated");
    expect(content).not.toContain("A test project");
  });

  it("preserves pre-existing user content around the managed block", async () => {
    const file = path.join(cwd, "CLAUDE.local.md");
    fs.writeFileSync(file, "# My notes\n\nkeep me\n", "utf8");
    await writeAgentMemoryFile("claude-code", cwd, BRIEF);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("keep me");
    expect(content).toContain("A test project");
  });

  it("removes the block when given an empty brief, keeping user content", async () => {
    const file = path.join(cwd, "CLAUDE.local.md");
    fs.writeFileSync(file, "# My notes\n\nkeep me\n", "utf8");
    await writeAgentMemoryFile("claude-code", cwd, BRIEF);
    await removeAgentMemoryFile("claude-code", cwd);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("keep me");
    expect(content).not.toContain("mc:recall");
  });

  it("no-ops for unsupported agents", async () => {
    expect(await writeAgentMemoryFile("codex", cwd, BRIEF)).toBe(false);
    expect(fs.existsSync(path.join(cwd, "CLAUDE.local.md"))).toBe(false);
    expect(fs.existsSync(path.join(cwd, "AGENTS.md"))).toBe(false);
  });

  it("ensures the file is git-ignored when the cwd is a git repo", async () => {
    initGitRepo(cwd);
    await writeAgentMemoryFile("claude-code", cwd, BRIEF);
    const gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
    expect(gitignore).toContain("CLAUDE.local.md");
    // Idempotent — a second write doesn't add a duplicate ignore line.
    await writeAgentMemoryFile("claude-code", cwd, BRIEF);
    const again = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
    expect(again.match(/CLAUDE\.local\.md/g)).toHaveLength(1);
  });

  it("does not touch .gitignore when the cwd is not a git repo", async () => {
    await writeAgentMemoryFile("claude-code", cwd, BRIEF);
    expect(fs.existsSync(path.join(cwd, ".gitignore"))).toBe(false);
  });
});

describe("blocks written by an earlier build (R20, KTD10)", () => {
  it("replaces a block written under the previous prose rather than duplicating it", async () => {
    // The marker, not the prose inside it, is what identifies the block — so a
    // file the previous build wrote is updated in place instead of gaining a
    // second managed block beside the first.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mc-memory-prev-"));
    const file = path.join(cwd, "CLAUDE.local.md");
    fs.writeFileSync(
      file,
      [
        "# CLAUDE.local.md",
        "",
        "<!-- mc:recall:start (managed by Mission Control — do not edit inside these markers) -->",
        "# Project memory (Mission Control Recall)",
        "",
        "Old content from the previous release.",
        "<!-- mc:recall:end -->",
        "",
        "My own notes.",
      ].join("\n"),
    );

    await writeAgentMemoryFile(
      "claude-code",
      cwd,
      "# Project memory (Chaos Wrangler Recall)\n\nFresh content.",
    );

    const updated = fs.readFileSync(file, "utf8");
    expect(updated.match(/mc:recall:start/g)).toHaveLength(1);
    expect(updated.match(/mc:recall:end/g)).toHaveLength(1);
    expect(updated).toContain("Fresh content.");
    expect(updated).not.toContain("Old content from the previous release.");
    expect(updated).toContain("My own notes.");
  });

  it("keeps the marker text exactly as already-installed files carry it", async () => {
    // These read as prose but are matched exactly. Rewording either one
    // orphans every block the previous build wrote.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mc-memory-marker-"));
    await writeAgentMemoryFile("claude-code", cwd, "# Project memory\n\nbody");

    const written = fs.readFileSync(path.join(cwd, "CLAUDE.local.md"), "utf8");
    expect(written).toContain(
      "<!-- mc:recall:start (managed by Mission Control — do not edit inside these markers) -->",
    );
    expect(written).toContain("<!-- mc:recall:end -->");
  });
});
