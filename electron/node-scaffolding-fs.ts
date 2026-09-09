import * as fsp from "node:fs/promises";
import type { ScaffoldingDirent, ScaffoldingFs } from "../src/shared/scaffolding-fs";

/**
 * The real filesystem, behind the asynchronous scaffolding interface.
 *
 * Kept apart from `session-scaffolding.ts` so the lint rule that bans
 * synchronous filesystem calls inside the cwd-scoped modules has one deliberate
 * place to point at instead of an exception per call site.
 */
export const nodeScaffoldingFs: ScaffoldingFs = {
  async exists(target) {
    try {
      await fsp.access(target);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (file) => fsp.readFile(file, "utf8"),
  writeFile: (file, data) => fsp.writeFile(file, data, "utf8"),
  async mkdir(dir) {
    await fsp.mkdir(dir, { recursive: true });
  },
  async readdir(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries as unknown as ScaffoldingDirent[];
  },
  copyFile: (from, to) => fsp.copyFile(from, to),
  async rm(target) {
    await fsp.rm(target, { recursive: true, force: true });
  },
};
