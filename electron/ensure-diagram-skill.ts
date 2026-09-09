import * as path from "node:path";
import type { TaskAgent } from "../src/shared/domain";
import { nodeScaffoldingFs, type ScaffoldingFs } from "../src/shared/scaffolding-fs";

import {
  DIAGRAM_SKILL_INSTALL_TARGETS,
  type DiagramSkillHarness,
} from "../src/shared/diagram-skill-install";

const AGENT_HARNESS: Partial<Record<TaskAgent, DiagramSkillHarness>> = {
  "claude-code": "claude",
  codex: "codex",
  "cursor-cli": "cursor",
};

function bundledDiagramSkillSourceDirs(appPath: string): string[] {
  return [
    path.join(appPath, ".agents", "skills", "diagram"),
    path.join(appPath, "dist", "bundled-skills", "diagram"),
    path.join(appPath, "dist-server", "bundled-skills", "diagram"),
  ];
}

async function resolveBundledDiagramSkillSource(
  appPath: string,
  fs: ScaffoldingFs,
): Promise<string | null> {
  for (const candidate of bundledDiagramSkillSourceDirs(appPath)) {
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

function diagramSkillTargetPaths(cwd: string, harness: DiagramSkillHarness): string[] {
  const segments = DIAGRAM_SKILL_INSTALL_TARGETS[harness].segments;
  const primary = path.join(cwd, ...segments);
  if (harness !== "cursor") return [primary];
  // Cursor loads from both `.cursor/skills/` and `.agents/skills/`.
  return [primary, path.join(cwd, ".agents", "skills", "diagram")];
}

/**
 * Best-effort install of the bundled diagram skill into the project cwd when
 * an agent session starts. Agents only discover skills from on-disk folders;
 * without this, users must run "Install diagram skill" manually per project.
 */
export async function ensureDiagramSkillForAgent(
  appPath: string,
  cwd: string,
  agent: TaskAgent | undefined,
  fs: ScaffoldingFs = nodeScaffoldingFs,
): Promise<void> {
  if (!agent) return;
  const harness = AGENT_HARNESS[agent];
  if (!harness) return;

  const sourceDir = await resolveBundledDiagramSkillSource(appPath, fs);
  if (!sourceDir) return;

  for (const targetDir of diagramSkillTargetPaths(cwd, harness)) {
    if (await fs.exists(path.join(targetDir, "SKILL.md"))) continue;
    try {
      await fs.rm(targetDir);
      await copySkillTree(sourceDir, targetDir, fs);
    } catch {
      /* swallow — skill install must never block PTY spawn */
    }
  }
}
