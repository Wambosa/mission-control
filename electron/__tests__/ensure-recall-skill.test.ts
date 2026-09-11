import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  RECALL_SKILL_MARKER,
  ensureRecallSkillForAgent,
  removeRecallSkillForAgent,
} from "../ensure-recall-skill";

// The repo root, where .agents/skills/recall lives (dev resolution).
const APP_PATH = path.resolve(__dirname, "..", "..");

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-recall-skill-"));
}

function skillDir(cwd: string): string {
  return path.join(cwd, ".claude", "skills", "recall");
}

describe("ensureRecallSkillForAgent / removeRecallSkillForAgent", () => {
  it("installs the bundled skill, then removal deletes it", async () => {
    const cwd = tmpCwd();
    await ensureRecallSkillForAgent(APP_PATH, cwd, "claude-code");
    expect(fs.existsSync(path.join(skillDir(cwd), "SKILL.md"))).toBe(true);

    await removeRecallSkillForAgent(cwd, "claude-code");
    expect(fs.existsSync(skillDir(cwd))).toBe(false);
  });

  it("removal spares a user-authored skill at the same path", async () => {
    const cwd = tmpCwd();
    fs.mkdirSync(skillDir(cwd), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir(cwd), "SKILL.md"),
      "---\nname: recall\n---\n\nMy own note-taking skill.\n",
      "utf8",
    );
    await removeRecallSkillForAgent(cwd, "claude-code");
    expect(fs.existsSync(path.join(skillDir(cwd), "SKILL.md"))).toBe(true);
  });

  it("removal is a no-op when nothing is installed", async () => {
    const cwd = tmpCwd();
    await expect(removeRecallSkillForAgent(cwd, "claude-code")).resolves.toBeUndefined();
  });

  it("removal cleans both cursor skill locations", async () => {
    const cwd = tmpCwd();
    await ensureRecallSkillForAgent(APP_PATH, cwd, "cursor-cli");
    const cursorDir = path.join(cwd, ".cursor", "skills", "recall");
    const agentsDir = path.join(cwd, ".agents", "skills", "recall");
    expect(fs.existsSync(path.join(cursorDir, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, "SKILL.md"))).toBe(true);

    await removeRecallSkillForAgent(cwd, "cursor-cli");
    expect(fs.existsSync(cursorDir)).toBe(false);
    expect(fs.existsSync(agentsDir)).toBe(false);
  });
});

describe("recognizing what earlier builds already installed (AE12, KTD10)", () => {
  /** Write a SKILL.md with the given body and try to remove it as managed. */
  async function removalKeeps(body: string): Promise<boolean> {
    const cwd = tmpCwd();
    fs.mkdirSync(skillDir(cwd), { recursive: true });
    fs.writeFileSync(path.join(skillDir(cwd), "SKILL.md"), body);
    await removeRecallSkillForAgent(cwd, "claude-code");
    return fs.existsSync(skillDir(cwd));
  }

  it("still recognizes a skill file carrying the previous product's prose", async () => {
    // The case this exists for: the previous build wrote this file. If the
    // rename orphaned it, the app would leave a second copy beside it in the
    // user's repository.
    expect(await removalKeeps("# Recall\n\nInstalled by Mission Control.\n")).toBe(false);
  });

  it("recognizes a skill file carrying the new product's prose", async () => {
    expect(await removalKeeps("# Recall\n\nInstalled by Chaos Wrangler.\n")).toBe(false);
  });

  it("recognizes a skill file by its marker alone, whatever the prose says", async () => {
    // The durable answer: a predicate matching the product name in prose stops
    // recognizing its own files the moment that name changes again.
    expect(await removalKeeps(`${RECALL_SKILL_MARKER}\n\n# Something else entirely\n`)).toBe(false);
  });

  it("leaves a file matching neither alone", async () => {
    expect(await removalKeeps("# My own skill\n\nNothing to do with the app.\n")).toBe(true);
  });

  it("does not treat a file that merely says Recall as the app's own", async () => {
    expect(await removalKeeps("# Recall\n\nMy own notes about recall.\n")).toBe(true);
  });

  it("installs a copy that carries the marker", async () => {
    const cwd = tmpCwd();
    await ensureRecallSkillForAgent(APP_PATH, cwd, "claude-code");
    const installed = fs.readFileSync(path.join(skillDir(cwd), "SKILL.md"), "utf8");
    expect(installed).toContain(RECALL_SKILL_MARKER);
  });
});
