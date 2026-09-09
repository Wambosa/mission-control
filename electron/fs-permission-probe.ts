import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  DeclaredLocation,
  FsPermissionOutcome,
  FsVolumeClass,
} from "../src/shared/fs-permission";

/**
 * Attempting a protected location, and classifying what came back.
 *
 * macOS exposes no API for the consent state of the file-access family, so the
 * only ground truth is the result of a real attempt. Enumeration is the
 * operation used because it is the one that both trips the privacy gate and
 * registers the app in the OS privacy list — a metadata call passes through a
 * gap in the gate and would report success on a directory the app cannot read.
 */

export type ReadDir = (dir: string) => Promise<unknown>;

export type MountEntry = { device: string; mountPoint: string; fsType: string };

export type ProbeDeps = {
  readdir: ReadDir;
  homeDir: () => string;
  listMounts: () => Promise<MountEntry[]>;
};

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Which outcome a failed enumeration represents.
 *
 * The split that matters is EPERM against EACCES. macOS's privacy gate rejects
 * above the filesystem with EPERM; ordinary POSIX mode bits reject with EACCES.
 * Only the first is grantable in the privacy pane, so only the first should
 * send the operator there.
 */
export function classifyProbeError(error: unknown): FsPermissionOutcome {
  switch (errorCode(error)) {
    case "EPERM":
      return "privacy-blocked";
    case "EACCES":
      return "filesystem-blocked";
    case "ENOENT":
    case "ENOTDIR":
      return "absent";
    default:
      // Not "we were denied" — "we learned nothing". Reporting it as blocked
      // would offer a privacy jump that cannot help.
      return "never-probed";
  }
}

/** One enumeration, classified. Never throws. */
export async function probeDirectory(dir: string, readdir: ReadDir): Promise<FsPermissionOutcome> {
  try {
    await readdir(dir);
    return "readable";
  } catch (error) {
    return classifyProbeError(error);
  }
}

const MOUNT_LINE = /^(.+) on (.+) \(([^,)]+)[,)]/;

/** Parse `mount(8)` output. Mount points may contain spaces, so the type anchors the split. */
export function parseMountEntries(stdout: string): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of stdout.split("\n")) {
    const match = MOUNT_LINE.exec(line.trim());
    if (!match) continue;
    entries.push({ device: match[1], mountPoint: match[2], fsType: match[3].trim() });
  }
  return entries;
}

const NETWORK_FS_TYPES = new Set(["smbfs", "cifs", "nfs", "afpfs", "webdav", "ftp"]);

/**
 * Mount points belonging to a volume class.
 *
 * Removable is inferred from the mount location rather than from a device
 * property, because `mount(8)` reports no removability flag. The boot volume's
 * firmlink can surface under /Volumes on some configurations; over-including it
 * costs one extra enumeration that succeeds, whereas under-including a real
 * external drive would make the app claim "unknowable" while a volume is
 * mounted, which R3 forbids.
 */
export function mountedVolumesOfClass(
  entries: readonly MountEntry[],
  volumeClass: FsVolumeClass,
): string[] {
  return entries
    .filter((entry) =>
      volumeClass === "network"
        ? NETWORK_FS_TYPES.has(entry.fsType)
        : entry.mountPoint.startsWith("/Volumes/") && !NETWORK_FS_TYPES.has(entry.fsType),
    )
    .map((entry) => entry.mountPoint);
}

/** Probe one declared location, resolving a volume category's mount first. */
export async function probeDeclaredLocation(
  location: DeclaredLocation,
  deps: ProbeDeps,
): Promise<FsPermissionOutcome> {
  if (location.volumeClass) {
    let mounts: readonly MountEntry[];
    try {
      mounts = await deps.listMounts();
    } catch {
      return "never-probed";
    }
    const volumes = mountedVolumesOfClass(mounts, location.volumeClass);
    // Nothing of this class mounted: an unasked category and a refused one are
    // indistinguishable, so claim neither.
    if (volumes.length === 0) return "unknowable";
    return probeDirectory(volumes[0], deps.readdir);
  }

  if (!location.homeRelativePath) return "never-probed";
  return probeDirectory(path.join(deps.homeDir(), location.homeRelativePath), deps.readdir);
}

// ---------------------------------------------------------------------------
// One probe in flight, process-wide.
//
// A blocked enumeration holds a libuv thread pool thread for the life of the
// process: the consent prompt has no timeout and an abort signal cannot cancel
// a syscall already in flight. The pool is four threads and this repo does not
// resize it, so four concurrent blocked probes stop every promise-based
// filesystem call in the main process while the app still looks responsive.
// Serialising probes bounds that exposure to one held thread.
//
// Time-staggering would not do it — probes spaced apart that each hang still
// end up concurrent. The chain is the cap.
// ---------------------------------------------------------------------------

let probeChain: Promise<unknown> = Promise.resolve();

/** Test-only: drop a chain a deliberately-stuck probe is still holding. */
export function __resetProbeQueueForTests(): void {
  probeChain = Promise.resolve();
}

export type QueuedProbeOptions = {
  /**
   * How long the caller will wait for an answer, covering both the queue wait
   * and the enumeration itself. This is a reporting bound, not a resource
   * bound: the held thread is not released when it expires.
   */
  deadlineMs?: number;
};

const DEFAULT_PROBE_DEADLINE_MS = 20_000;

/**
 * Probe a directory through the process-wide one-in-flight chain.
 *
 * Resolves `pending` when the deadline passes with no answer — a caller that
 * waited forever behind a stuck probe would recreate the freeze this exists to
 * prevent.
 */
export function probeDirectoryQueued(
  dir: string,
  readdir: ReadDir,
  options: QueuedProbeOptions = {},
): Promise<FsPermissionOutcome> {
  const deadlineMs = options.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS;

  const queued = probeChain.then(() => probeDirectory(dir, readdir));
  // The chain advances on the probe, so a stuck probe holds the queue — that is
  // the cap doing its job. `catch` only guards against an unexpected throw
  // breaking the chain for everyone behind it.
  probeChain = queued.catch(() => undefined);

  return new Promise<FsPermissionOutcome>((resolve) => {
    const timer = setTimeout(() => resolve("pending"), deadlineMs);
    // Never hold the event loop open for a probe nobody is waiting on.
    timer.unref?.();
    void queued.then(
      (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      },
      () => {
        clearTimeout(timer);
        resolve("never-probed");
      },
    );
  });
}

/** Probe one declared location through the same one-in-flight chain. */
export async function probeDeclaredLocationQueued(
  location: DeclaredLocation,
  deps: ProbeDeps,
  options: QueuedProbeOptions = {},
): Promise<FsPermissionOutcome> {
  if (location.volumeClass) {
    let mounts: readonly MountEntry[];
    try {
      mounts = await deps.listMounts();
    } catch {
      return "never-probed";
    }
    const volumes = mountedVolumesOfClass(mounts, location.volumeClass);
    if (volumes.length === 0) return "unknowable";
    return probeDirectoryQueued(volumes[0], deps.readdir, options);
  }

  if (!location.homeRelativePath) return "never-probed";
  return probeDirectoryQueued(
    path.join(deps.homeDir(), location.homeRelativePath),
    deps.readdir,
    options,
  );
}

const MOUNT_COMMAND_TIMEOUT_MS = 5_000;

function listMountsFromCommand(): Promise<MountEntry[]> {
  return new Promise((resolve, reject) => {
    execFile("/sbin/mount", [], { timeout: MOUNT_COMMAND_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(parseMountEntries(stdout));
    });
  });
}

/** The real filesystem, the real home directory, the real mount table. */
export function createProbeDeps(): ProbeDeps {
  return {
    readdir: (dir) => fsp.readdir(dir),
    homeDir: () => os.homedir(),
    listMounts: listMountsFromCommand,
  };
}
