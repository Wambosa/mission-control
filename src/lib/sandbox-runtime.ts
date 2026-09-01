import { getElectron, type ElectronBridge } from "~/lib/electron";
import type { SandboxRuntimeMode } from "~/shared/electron-contract";

/**
 * Which machine a project's sessions run on. Read from the project itself —
 * its `sandboxId` column — not from an application-wide "active scope". Two
 * projects on two different machines are therefore live at the same time, and
 * a session never resolves its target from whichever project was opened last.
 *
 * `null` is Local: the host this app is running on.
 */
export function projectRuntimeMode(sandboxId: string | null | undefined): SandboxRuntimeMode {
  return sandboxId ? "docker" : "host";
}

/** True when this project's sessions and file/git calls go over the agent. */
export function isRemoteProjectRuntime(sandboxId: string | null | undefined): boolean {
  return projectRuntimeMode(sandboxId) === "docker";
}

/**
 * Where each scope keeps its projects, cached per scope because the path
 * mapping needs it synchronously while rendering, where an await is not
 * available. Only the managed-VM derivation reads this: an SSH-host project
 * states its own directory (see `projectRemoteRoot`).
 */
const remoteRootByScope = new Map<string, string | null>();

/** A scope's project root, or null before its first read (and for Local). */
export function cachedSandboxRemoteRoot(sandboxId: string | null | undefined): string | null {
  return sandboxId ? remoteRootByScope.get(sandboxId) ?? null : null;
}

/** One read of a scope's root, tolerant of an older main process. Cached. */
export async function readSandboxRemoteRoot(
  sandboxId: string | null | undefined,
  electron: ElectronBridge | null = getElectron(),
): Promise<string | null> {
  if (!sandboxId || !electron?.sandbox) return null;
  const cached = remoteRootByScope.get(sandboxId);
  if (cached !== undefined) return cached;
  let root: string | null = null;
  try {
    root = (await electron.sandbox.getRemoteRoot?.(sandboxId)) ?? null;
  } catch {
    root = null;
  }
  remoteRootByScope.set(sandboxId, root);
  return root;
}
