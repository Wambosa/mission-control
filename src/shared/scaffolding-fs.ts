/**
 * The filesystem interface every piece of session-scaffolding work takes as a
 * parameter.
 *
 * Two reasons it is a parameter rather than a direct `node:fs` import. Tests
 * drive the scaffolding without touching a real protected path, and — the load-
 * bearing one — every operation here is asynchronous, so a read that stalls
 * behind a macOS consent prompt cannot park the Electron main thread.
 *
 * Asynchrony alone is not the whole protection and must not be mistaken for it:
 * a promise-based filesystem call runs on the libuv thread pool, which is four
 * threads, and a blocked read holds one of them for the life of the process.
 * The caller's cwd probe is what stops the read being issued at all. See
 * `electron/session-scaffolding.ts`.
 */

export type ScaffoldingDirent = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

export type ScaffoldingFs = {
  /** Metadata only — passes through the privacy gate, so never proof of readability. */
  exists(target: string): Promise<boolean>;
  readFile(file: string): Promise<string>;
  writeFile(file: string, data: string): Promise<void>;
  /** Always recursive. */
  mkdir(dir: string): Promise<void>;
  readdir(dir: string): Promise<ScaffoldingDirent[]>;
  copyFile(from: string, to: string): Promise<void>;
  /** Always recursive and forced. Enumerates, so the privacy gate applies. */
  rm(target: string): Promise<void>;
};

/** The subset the agent auto-load file writer needs. */
export type MemoryFileFs = Pick<ScaffoldingFs, "exists" | "readFile" | "writeFile" | "mkdir">;
