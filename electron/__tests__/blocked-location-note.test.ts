import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockedLocationNote, installBlockedLocationNote } from "../blocked-location-note";
import { writeAgentMemoryBlock } from "../../src/shared/agent-memory-file";
import type { FsPermissionRecord } from "../../src/shared/fs-permission";

const dirs: string[] = [];
function tmpCwd(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-blocked-note-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function record(
  category: FsPermissionRecord["category"],
  outcome: FsPermissionRecord["outcome"],
): FsPermissionRecord {
  return { category, outcome, checkedAt: 1 };
}

function autoLoadFile(cwd: string): string {
  return fs.readFileSync(path.join(cwd, "CLAUDE.local.md"), "utf8");
}

describe("blockedLocationNote", () => {
  it("names each blocked location and how it is blocked", () => {
    const note = blockedLocationNote([
      record("documents", "privacy-blocked"),
      record("desktop", "filesystem-blocked"),
      record("downloads", "readable"),
    ]);
    expect(note).toContain("Documents folder");
    expect(note).toContain("macOS privacy gate");
    expect(note).toContain("Desktop folder");
    expect(note).toContain("ordinary file permissions");
    expect(note).not.toContain("Downloads");
  });

  it("is empty when nothing is blocked", () => {
    expect(
      blockedLocationNote([
        record("documents", "readable"),
        record("removable-volumes", "unknowable"),
        record("desktop", "never-probed"),
        record("downloads", "pending"),
      ]),
    ).toBe("");
  });

  it("tells the agent where the operator fixes it, rather than to retry", () => {
    const note = blockedLocationNote([record("documents", "privacy-blocked")]);
    expect(note).toContain("Do not retry");
    expect(note).toContain("Diagnostics");
  });
});

describe("installBlockedLocationNote", () => {
  it("writes a note for a blocked location", async () => {
    const cwd = tmpCwd();
    await installBlockedLocationNote({
      agent: "claude-code",
      cwd,
      records: [record("documents", "privacy-blocked")],
    });
    expect(autoLoadFile(cwd)).toContain("Documents folder");
  });

  it("writes nothing when no location is blocked", async () => {
    const cwd = tmpCwd();
    await installBlockedLocationNote({
      agent: "claude-code",
      cwd,
      records: [record("documents", "readable")],
    });
    expect(fs.existsSync(path.join(cwd, "CLAUDE.local.md"))).toBe(false);
  });

  it("gives an agent outside the injection table no note and no error", async () => {
    const cwd = tmpCwd();
    for (const agent of ["codex", "cursor-cli", "opencode", undefined]) {
      await expect(
        installBlockedLocationNote({
          agent,
          cwd,
          records: [record("documents", "privacy-blocked")],
        }),
      ).resolves.toBeUndefined();
    }
    expect(fs.readdirSync(cwd)).toEqual([]);
  });

  it("leaves session start unaffected when the write throws", async () => {
    const cwd = tmpCwd();
    const exploding = {
      exists: async () => false,
      readFile: async () => {
        throw new Error("disk on fire");
      },
      writeFile: async () => {
        throw new Error("disk on fire");
      },
      mkdir: async () => {
        throw new Error("disk on fire");
      },
    };
    await expect(
      installBlockedLocationNote({
        agent: "claude-code",
        cwd,
        records: [record("documents", "privacy-blocked")],
        fs: exploding,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("the two managed blocks share a file without touching each other", () => {
  const BRIEF = "# Project memory\n\n- the build is pnpm";
  const NOTE = "## Filesystem access\n\n- Documents is blocked";

  it("writing a note leaves an existing brief intact", async () => {
    const cwd = tmpCwd();
    await writeAgentMemoryBlock("claude-code", cwd, "recall", BRIEF);
    await writeAgentMemoryBlock("claude-code", cwd, "permissions", NOTE);

    const content = autoLoadFile(cwd);
    expect(content).toContain("the build is pnpm");
    expect(content).toContain("Documents is blocked");
  });

  it("writing a brief leaves an existing note intact", async () => {
    const cwd = tmpCwd();
    await writeAgentMemoryBlock("claude-code", cwd, "permissions", NOTE);
    await writeAgentMemoryBlock("claude-code", cwd, "recall", BRIEF);

    const content = autoLoadFile(cwd);
    expect(content).toContain("Documents is blocked");
    expect(content).toContain("the build is pnpm");
  });

  it("an empty brief removes the brief block and leaves the note", async () => {
    const cwd = tmpCwd();
    await writeAgentMemoryBlock("claude-code", cwd, "recall", BRIEF);
    await writeAgentMemoryBlock("claude-code", cwd, "permissions", NOTE);
    await writeAgentMemoryBlock("claude-code", cwd, "recall", "");

    const content = autoLoadFile(cwd);
    expect(content).not.toContain("the build is pnpm");
    expect(content).not.toContain("mc:recall:start");
    expect(content).toContain("Documents is blocked");
  });

  it("an empty note removes the note block and leaves the brief", async () => {
    const cwd = tmpCwd();
    await writeAgentMemoryBlock("claude-code", cwd, "recall", BRIEF);
    await writeAgentMemoryBlock("claude-code", cwd, "permissions", NOTE);
    await writeAgentMemoryBlock("claude-code", cwd, "permissions", "");

    const content = autoLoadFile(cwd);
    expect(content).toContain("the build is pnpm");
    expect(content).not.toContain("Documents is blocked");
    expect(content).not.toContain("mc:permissions:start");
  });

  it("a failed brief fetch leaves a previously written note in place", async () => {
    // The single-block writer would have erased it: a fetch failure clears the
    // brief by writing an empty one, and every block lived under one marker.
    const cwd = tmpCwd();
    await writeAgentMemoryBlock("claude-code", cwd, "permissions", NOTE);
    const { installAgentMemoryBrief } = await import("../agent-memory-brief");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("server down"));
    try {
      await installAgentMemoryBrief({
        agent: "claude-code",
        cwd,
        taskId: "t-1",
        mcEnv: { apiUrl: "http://127.0.0.1:1", token: "t" } as never,
      });
    } finally {
      fetchSpy.mockRestore();
    }

    expect(autoLoadFile(cwd)).toContain("Documents is blocked");
  });

  it("leaves pre-existing user content outside both blocks untouched", async () => {
    const cwd = tmpCwd();
    fs.writeFileSync(path.join(cwd, "CLAUDE.local.md"), "my own private notes\n", "utf8");
    await writeAgentMemoryBlock("claude-code", cwd, "recall", BRIEF);
    await writeAgentMemoryBlock("claude-code", cwd, "permissions", NOTE);
    await writeAgentMemoryBlock("claude-code", cwd, "recall", "");
    await writeAgentMemoryBlock("claude-code", cwd, "permissions", "");

    expect(autoLoadFile(cwd).trim()).toBe("my own private notes");
  });

  it("leaves a malformed block alone rather than clobbering the file", async () => {
    const cwd = tmpCwd();
    const malformed = "before\n<!-- mc:permissions:start -->\nstranded\n";
    fs.writeFileSync(path.join(cwd, "CLAUDE.local.md"), malformed, "utf8");
    await writeAgentMemoryBlock("claude-code", cwd, "permissions", NOTE);

    const content = autoLoadFile(cwd);
    expect(content).toContain("before");
    expect(content).toContain("stranded");
  });

  it("git-ignores the auto-load file after a note-only write", async () => {
    const cwd = tmpCwd();
    fs.mkdirSync(path.join(cwd, ".git"));
    await writeAgentMemoryBlock("claude-code", cwd, "permissions", NOTE);
    expect(fs.readFileSync(path.join(cwd, ".gitignore"), "utf8")).toContain("CLAUDE.local.md");
  });
});
