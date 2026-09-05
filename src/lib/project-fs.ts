// Routes the file browser / editor to the host filesystem (local Electron PTY
// runtime) or to the in-container clone over RPC (Docker sandbox runtime),
// behind one `(projectRoot, relPath)` interface. Defaults to host — when the
// Terminal runtime isn't "docker", every call is exactly the prior behavior.
import { SANDBOX_WORKSPACE_ROOT, workspaceSlug } from "~/shared/sandbox-workspace";
import {
  cachedSandboxRemoteRoot,
  isRemoteProjectRuntime,
  readSandboxRemoteRoot,
} from "~/lib/sandbox-runtime";
import type {
  FileListResult,
  FileReadResult,
  FileWriteResult,
} from "~/shared/electron-contract";

/**
 * Where a Mission Control VM keeps a project: its workspace root plus a slug of
 * the local folder's name. The VM creates the project itself (see
 * project-sandbox-create), so the layout is ours to derive.
 *
 * This is NOT how an SSH host works. There the project is somewhere the user
 * put it, which they now state per project — see `projectRemoteRoot`.
 */
export function sandboxContainerRoot(projectRoot: string, sandboxId?: string | null): string {
  const root = (cachedSandboxRemoteRoot(sandboxId) ?? SANDBOX_WORKSPACE_ROOT).replace(/\/+$/, "");
  // A Windows path arrives with backslashes; its last segment is still the name.
  const name = projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? "project";
  return `${root}/${workspaceSlug(name)}`;
}

/**
 * Where this project lives on whatever machine its sessions run on. A project
 * bound to an SSH host says so outright; anything else falls back to the
 * managed-VM derivation above.
 */
export function projectRemoteRoot(
  projectRoot: string,
  remoteDirectory?: string | null,
  sandboxId?: string | null,
): string {
  const configured = remoteDirectory?.trim().replace(/\/+$/, "");
  return configured || sandboxContainerRoot(projectRoot, sandboxId);
}

/**
 * Which machine a project's files live on, and where. Passed to every fs call
 * so two projects on two hosts can be browsed at once.
 */
export type ProjectFsScope = {
  /** null = Local (this machine). */
  sandboxId: string | null;
  /** The project's directory on that machine; null = derive (managed VM). */
  remoteDirectory: string | null;
};

const LOCAL_SCOPE: ProjectFsScope = { sandboxId: null, remoteDirectory: null };

function containerPath(projectRoot: string, relPath: string, scope: ProjectFsScope): string {
  return `${projectRemoteRoot(projectRoot, scope.remoteDirectory, scope.sandboxId)}/${relPath}`;
}

/** True when this project's files live off this machine (so fs/git go over RPC). */
export async function isRemoteProjectFs(scope: ProjectFsScope): Promise<boolean> {
  if (!isRemoteProjectRuntime(scope.sandboxId)) return false;
  // Warm the scope's root so the synchronous path mapping above can read it.
  if (!scope.remoteDirectory) await readSandboxRemoteRoot(scope.sandboxId);
  return true;
}

const NOT_ELECTRON = { ok: false as const, error: "Not running in Electron" };

export async function listProjectFiles(
  projectRoot: string,
  scope: ProjectFsScope = LOCAL_SCOPE,
): Promise<FileListResult> {
  const api = window.electronAPI;
  if (!api) return NOT_ELECTRON;
  return (await isRemoteProjectFs(scope))
    ? api.remoteFs.list(
        scope.sandboxId,
        projectRemoteRoot(projectRoot, scope.remoteDirectory, scope.sandboxId),
      )
    : api.files.list(projectRoot);
}

export async function readProjectFile(
  projectRoot: string,
  relPath: string,
  scope: ProjectFsScope = LOCAL_SCOPE,
): Promise<FileReadResult> {
  const api = window.electronAPI;
  if (!api) return NOT_ELECTRON;
  return (await isRemoteProjectFs(scope))
    ? api.remoteFs.read(scope.sandboxId, containerPath(projectRoot, relPath, scope))
    : api.files.read(projectRoot, relPath);
}

export async function writeProjectFile(
  projectRoot: string,
  relPath: string,
  content: string,
  expectedMtimeMs: number | null,
  scope: ProjectFsScope = LOCAL_SCOPE,
): Promise<FileWriteResult> {
  const api = window.electronAPI;
  if (!api) return NOT_ELECTRON;
  return (await isRemoteProjectFs(scope))
    ? api.remoteFs.write(
        scope.sandboxId,
        containerPath(projectRoot, relPath, scope),
        content,
        expectedMtimeMs,
      )
    : api.files.write(projectRoot, relPath, content, expectedMtimeMs);
}

/**
 * Host-only escalation: a protected-path write goes through the native confirm
 * dialog. The sandbox agent has no such dialog — it just enforces the deny-list —
 * so there the call is the same plain remote write (a protected path stays
 * refused).
 */
export async function writeProjectFileSensitive(
  projectRoot: string,
  relPath: string,
  content: string,
  expectedMtimeMs: number | null,
  scope: ProjectFsScope = LOCAL_SCOPE,
): Promise<FileWriteResult> {
  const api = window.electronAPI;
  if (!api) return NOT_ELECTRON;
  return (await isRemoteProjectFs(scope))
    ? api.remoteFs.write(
        scope.sandboxId,
        containerPath(projectRoot, relPath, scope),
        content,
        expectedMtimeMs,
      )
    : api.files.writeSensitive(projectRoot, relPath, content, expectedMtimeMs);
}

/**
 * Starts (or reuses) the loopback static server rooted at `projectRoot` so the
 * HTML preview iframe can load the file over http and resolve its assets/scripts.
 * Host-runtime only: in the Docker sandbox the files live in the container, which
 * this host server can't serve — callers fall back to the inert srcDoc preview.
 */
export async function startHtmlPreviewServer(
  projectRoot: string,
): Promise<{ ok: true; port: number } | { ok: false; error: string }> {
  const api = window.electronAPI;
  if (!api?.preview) return NOT_ELECTRON;
  return api.preview.startServer(projectRoot);
}

export type ProjectFileWatch = {
  watchId: string;
  /** Subscribe to change events for THIS watch (filter by watchId). Returns unsubscribe. */
  onChanged: (cb: (msg: { watchId: string; mtimeMs: number }) => void) => () => void;
  unwatch: () => void;
};

export async function watchProjectFile(
  projectRoot: string,
  relPath: string,
  scope: ProjectFsScope = LOCAL_SCOPE,
): Promise<{ ok: true; watch: ProjectFileWatch } | { ok: false; error: string }> {
  const api = window.electronAPI;
  if (!api) return NOT_ELECTRON;
  if (await isRemoteProjectFs(scope)) {
    const r = await api.remoteFs.watch(
      scope.sandboxId,
      containerPath(projectRoot, relPath, scope),
    );
    if (!r.ok) return r;
    return {
      ok: true,
      watch: {
        watchId: r.watchId,
        onChanged: (cb) => api.remoteFs.onChange((m) => cb({ watchId: m.watchId, mtimeMs: m.mtimeMs })),
        unwatch: () => void api.remoteFs.unwatch(scope.sandboxId, r.watchId),
      },
    };
  }
  const r = await api.files.watch(projectRoot, relPath);
  if (!r.ok) return r;
  return {
    ok: true,
    watch: {
      watchId: r.watchId,
      onChanged: (cb) => api.files.onChanged(cb),
      unwatch: () => void api.files.unwatch(r.watchId),
    },
  };
}
