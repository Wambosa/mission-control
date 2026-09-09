import * as path from "node:path";
import type { TaskAgent } from "../src/shared/domain";
import { nodeScaffoldingFs, type ScaffoldingFs } from "../src/shared/scaffolding-fs";


// Per-harness skill folder segments (mirrors DIAGRAM_SKILL_INSTALL_TARGETS).
// The Recall skill is just instructions, so it installs into whichever CLI's
// skills folder the session uses.
const HARNESS_SEGMENTS: Partial<Record<TaskAgent, string[]>> = {
  "claude-code": [".claude", "skills", "recall"],
  codex: [".codex", "skills", "recall"],
  "cursor-cli": [".cursor", "skills", "recall"],
};

function bundledRecallSkillSourceDirs(appPath: string): string[] {
  // In dev, `app.getAppPath()` resolves to `<repo>/dist-electron/electron`, so
  // appPath-anchored lookups miss the repo-root source; `process.cwd()` is the
  // repo root (the electron main is launched from there). Packaged builds keep
  // the appPath (asar) + dist paths. See the same fix in ensure-recall-mcp.ts.
  return [
    path.join(process.cwd(), ".agents", "skills", "recall"),
    path.join(process.cwd(), "dist", "bundled-skills", "recall"),
    path.join(appPath, ".agents", "skills", "recall"),
    path.join(appPath, "dist", "bundled-skills", "recall"),
    path.join(appPath, "dist-server", "bundled-skills", "recall"),
    path.join(appPath, "..", "..", ".agents", "skills", "recall"),
    path.join(appPath, "..", "..", "dist", "bundled-skills", "recall"),
  ];
}

async function resolveBundledRecallSkillSource(
  appPath: string,
  fs: ScaffoldingFs,
): Promise<string | null> {
  for (const candidate of bundledRecallSkillSourceDirs(appPath)) {
    if (await fs.exists(path.join(candidate, "SKILL.md"))) return candidate;
  }
  return null;
}

async function copySkillTree(
  sourceDir: string,
  targetDir: string,
  fs: ScaffoldingFs,
): Promise<void> {
  await fs.mkdir(targetDir);
  for (const entry of await fs.readdir(sourceDir)) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copySkillTree(from, to, fs);
      continue;
    }
    if (!entry.isFile()) continue;
    await fs.copyFile(from, to);
  }
}

function recallSkillTargetPaths(cwd: string, agent: TaskAgent): string[] {
  const segments = HARNESS_SEGMENTS[agent];
  if (!segments) return [];
  const primary = path.join(cwd, ...segments);
  if (agent !== "cursor-cli") return [primary];
  // Cursor loads from both `.cursor/skills/` and `.agents/skills/`.
  return [primary, path.join(cwd, ".agents", "skills", "recall")];
}

/**
 * Best-effort install of the bundled Recall skill into the project cwd when an
 * agent session starts, so the agent knows it can persist project knowledge to
 * Recall. Agents only discover skills from on-disk folders. Fully fail-soft —
 * installing a skill must never block or delay PTY spawn.
 */
export async function ensureRecallSkillForAgent(
  appPath: string,
  cwd: string,
  agent: TaskAgent | undefined,
  fs: ScaffoldingFs = nodeScaffoldingFs,
): Promise<void> {
  if (!agent) return;
  const targets = recallSkillTargetPaths(cwd, agent);
  if (!targets.length) return;

  const sourceDir = await resolveBundledRecallSkillSource(appPath, fs);
  if (!sourceDir) return;

  for (const targetDir of targets) {
    if (await fs.exists(path.join(targetDir, "SKILL.md"))) continue;
    try {
      await fs.rm(targetDir);
      await copySkillTree(sourceDir, targetDir, fs);
    } catch {
      /* swallow — skill install must never block PTY spawn */
    }
  }
}

// A copy is only "ours" when its SKILL.md self-identifies as Mission Control's
// Recall skill — every bundled version has carried both phrases. The installer
// above never overwrites an existing SKILL.md, so a user-authored skill that
// happens to live at the same path must survive removal.
async function isManagedRecallSkill(skillFile: string, fs: ScaffoldingFs): Promise<boolean> {
  try {
    const content = await fs.readFile(skillFile);
    return content.includes("Mission Control") && content.includes("Recall");
  } catch {
    return false;
  }
}

/**
 * The inverse of ensureRecallSkillForAgent, for when the Recall master switch
 * is off: delete the managed skill folder(s) so the next session stops seeing
 * Recall instructions. Only removes copies that pass the ownership check.
 * Fully fail-soft — cleanup must never block PTY spawn.
 */
export async function removeRecallSkillForAgent(
  cwd: string,
  agent: TaskAgent | undefined,
  fs: ScaffoldingFs = nodeScaffoldingFs,
): Promise<void> {
  if (!agent) return;
  for (const targetDir of recallSkillTargetPaths(cwd, agent)) {
    try {
      if (!(await isManagedRecallSkill(path.join(targetDir, "SKILL.md"), fs))) continue;
      await fs.rm(targetDir);
    } catch {
      /* swallow */
    }
  }
}
