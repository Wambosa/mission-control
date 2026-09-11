import * as path from "node:path";
import type { TaskAgent } from "../src/shared/domain";
import { nodeScaffoldingFs, type ScaffoldingFs } from "../src/shared/scaffolding-fs";
import { PRODUCT_DISPLAY_NAME } from "../src/shared/user-data-paths";
import { PREVIOUS_PRODUCT_DISPLAY_NAME } from "../src/shared/user-data-migration";


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

/**
 * Is this SKILL.md one the app installed?
 *
 * The installer never overwrites an existing SKILL.md, so a user-authored
 * skill living at the same path has to survive removal — which is why this
 * asks the question at all rather than deleting the directory outright.
 *
 * Newly installed copies carry an explicit marker, which is the durable answer:
 * a predicate that matches the product's name in prose stops recognizing its
 * own files the moment that name changes. Copies written before the marker
 * existed are still recognized by prose, and **both** names are accepted —
 * dropping the previous one would orphan every skill file the previous build
 * installed, leaving a second copy beside it in the user's repository.
 */
export const RECALL_SKILL_MARKER = "<!-- mc:recall-skill (managed) -->";

async function isManagedRecallSkill(skillFile: string, fs: ScaffoldingFs): Promise<boolean> {
  try {
    const content = await fs.readFile(skillFile);
    if (content.includes(RECALL_SKILL_MARKER)) return true;
    const namesTheApp =
      content.includes(PRODUCT_DISPLAY_NAME) || content.includes(PREVIOUS_PRODUCT_DISPLAY_NAME);
    return namesTheApp && content.includes("Recall");
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
