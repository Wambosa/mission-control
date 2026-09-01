import { getElectron, type ElectronBridge } from "~/lib/electron";
import type { SandboxRuntimeMode } from "~/shared/electron-contract";

let cachedRuntimeMode: SandboxRuntimeMode | null = null;

/**
 * Where the active scope keeps its projects. Cached beside the runtime mode
 * because the two are read together and change together — switching scope
 * changes both — and because the path mapping needs it synchronously while
 * rendering, where an await is not available.
 */
let cachedRemoteRoot: string | null = null;

export function cachedSandboxRuntimeMode(): SandboxRuntimeMode | null {
  return cachedRuntimeMode;
}

/** The active scope's project root, or null before the first read. */
export function cachedSandboxRemoteRoot(): string | null {
  return cachedRemoteRoot;
}

export async function readSandboxRuntimeMode(
  electron: ElectronBridge | null = getElectron(),
): Promise<SandboxRuntimeMode> {
  if (!electron?.sandbox) {
    cachedRuntimeMode = "host";
    return "host";
  }

  try {
    // Phase 2: runtime follows the active scope. The manager returns a non-disabled
    // state for getState() (no arg) exactly when a sandbox scope is active; Local
    // (or no selection) yields `disabled` → host PTY.
    const state = await electron.sandbox.getState();
    const mode: SandboxRuntimeMode = state.status === "disabled" ? "host" : "docker";
    cachedRuntimeMode = mode;
    // Refresh the root in the same pass so it can never lag the mode: a scope
    // switch that updated one but not the other would map paths for the
    // machine the user just left.
    cachedRemoteRoot = mode === "docker" ? await readRemoteRoot(electron) : null;
    return mode;
  } catch {
    cachedRuntimeMode = "host";
    cachedRemoteRoot = null;
    return "host";
  }
}

export async function isDockerSandboxRuntime(
  electron: ElectronBridge | null = getElectron(),
): Promise<boolean> {
  return (await readSandboxRuntimeMode(electron)) === "docker";
}

/** One read of the active scope's root, tolerant of an older main process. */
async function readRemoteRoot(electron: ElectronBridge): Promise<string | null> {
  try {
    return (await electron.sandbox.getRemoteRoot?.()) ?? null;
  } catch {
    return null;
  }
}
