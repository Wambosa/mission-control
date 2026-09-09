import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetProbeQueueForTests,
  classifyProbeError,
  mountedVolumesOfClass,
  parseMountEntries,
  probeDeclaredLocation,
  probeDirectory,
  probeDirectoryQueued,
  type MountEntry,
  type ProbeDeps,
} from "../fs-permission-probe";
import { findDeclaredLocation } from "../../src/shared/fs-permission";

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(`stub ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    readdir: async () => [],
    homeDir: () => "/Users/tester",
    listMounts: async () => [],
    ...overrides,
  };
}

const documents = findDeclaredLocation("documents")!;
const removable = findDeclaredLocation("removable-volumes")!;
const network = findDeclaredLocation("network-volumes")!;

afterEach(() => {
  __resetProbeQueueForTests();
  vi.useRealTimers();
});

describe("classifyProbeError", () => {
  it("classifies the privacy gate's EPERM as privacy-blocked", () => {
    expect(classifyProbeError(fsError("EPERM"))).toBe("privacy-blocked");
  });

  it("classifies an ordinary EACCES as filesystem-blocked, distinctly from the privacy case", () => {
    expect(classifyProbeError(fsError("EACCES"))).toBe("filesystem-blocked");
    expect(classifyProbeError(fsError("EACCES"))).not.toBe(
      classifyProbeError(fsError("EPERM")),
    );
  });

  it("classifies a missing directory as absent, not as blocked", () => {
    expect(classifyProbeError(fsError("ENOENT"))).toBe("absent");
    expect(classifyProbeError(fsError("ENOTDIR"))).toBe("absent");
  });

  it("classifies an unrecognised error as never-probed rather than propagating", () => {
    expect(classifyProbeError(fsError("EMFILE"))).toBe("never-probed");
    expect(classifyProbeError(new Error("no code at all"))).toBe("never-probed");
    expect(classifyProbeError("not an error")).toBe("never-probed");
  });
});

describe("probeDirectory", () => {
  it("classifies a successful enumeration as readable", async () => {
    await expect(probeDirectory("/anywhere", async () => ["a"])).resolves.toBe("readable");
  });

  it("classifies a rejected enumeration by its error code", async () => {
    await expect(
      probeDirectory("/anywhere", async () => {
        throw fsError("EPERM");
      }),
    ).resolves.toBe("privacy-blocked");
  });
});

describe("parseMountEntries", () => {
  it("reads device, mount point and filesystem type from mount(8) output", () => {
    const stdout = [
      "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
      "//guest@files.local/share on /Volumes/share (smbfs, nodev, nosuid, mounted by admin)",
      "/dev/disk4s1 on /Volumes/My Backup Disk (msdos, local, nodev, nosuid, noowners)",
      "",
    ].join("\n");
    expect(parseMountEntries(stdout)).toEqual([
      { device: "/dev/disk3s1s1", mountPoint: "/", fsType: "apfs" },
      { device: "//guest@files.local/share", mountPoint: "/Volumes/share", fsType: "smbfs" },
      { device: "/dev/disk4s1", mountPoint: "/Volumes/My Backup Disk", fsType: "msdos" },
    ]);
  });

  it("ignores a line it cannot parse rather than throwing", () => {
    expect(parseMountEntries("this is not a mount line\n")).toEqual([]);
  });
});

describe("mountedVolumesOfClass", () => {
  const entries: MountEntry[] = [
    { device: "/dev/disk3s1s1", mountPoint: "/", fsType: "apfs" },
    { device: "//a@b/share", mountPoint: "/Volumes/share", fsType: "smbfs" },
    { device: "server:/export", mountPoint: "/Volumes/nfsmount", fsType: "nfs" },
    { device: "/dev/disk4s1", mountPoint: "/Volumes/USB", fsType: "msdos" },
  ];

  it("selects network filesystems by type, wherever they are mounted", () => {
    expect(mountedVolumesOfClass(entries, "network")).toEqual([
      "/Volumes/share",
      "/Volumes/nfsmount",
    ]);
  });

  it("selects non-network volumes under /Volumes as removable", () => {
    expect(mountedVolumesOfClass(entries, "removable")).toEqual(["/Volumes/USB"]);
  });

  it("finds nothing when only the boot volume is mounted", () => {
    const bootOnly = [entries[0]];
    expect(mountedVolumesOfClass(bootOnly, "removable")).toEqual([]);
    expect(mountedVolumesOfClass(bootOnly, "network")).toEqual([]);
  });
});

describe("probeDeclaredLocation", () => {
  it("enumerates a home-relative location under the resolved home directory", async () => {
    const seen: string[] = [];
    const outcome = await probeDeclaredLocation(
      documents,
      deps({
        readdir: async (dir) => {
          seen.push(dir);
          return [];
        },
      }),
    );
    expect(outcome).toBe("readable");
    expect(seen).toEqual(["/Users/tester/Documents"]);
  });

  it("reports unknowable for a volume category with nothing mounted, without enumerating", async () => {
    const readdir = vi.fn(async () => []);
    await expect(probeDeclaredLocation(removable, deps({ readdir }))).resolves.toBe(
      "unknowable",
    );
    expect(readdir).not.toHaveBeenCalled();
  });

  it("enumerates a mounted volume of the class and classifies the result", async () => {
    const seen: string[] = [];
    const outcome = await probeDeclaredLocation(
      network,
      deps({
        listMounts: async () => [
          { device: "//a@b/share", mountPoint: "/Volumes/share", fsType: "smbfs" },
        ],
        readdir: async (dir) => {
          seen.push(dir);
          throw fsError("EPERM");
        },
      }),
    );
    expect(outcome).toBe("privacy-blocked");
    expect(seen).toEqual(["/Volumes/share"]);
  });

  it("reports never-probed when the mount list itself cannot be read", async () => {
    await expect(
      probeDeclaredLocation(
        removable,
        deps({
          listMounts: async () => {
            throw new Error("mount unavailable");
          },
        }),
      ),
    ).resolves.toBe("never-probed");
  });
});

describe("probeDirectoryQueued", () => {
  it("runs one probe at a time even when several are requested together", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const readdir = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return [];
    };

    const outcomes = await Promise.all([
      probeDirectoryQueued("/a", readdir),
      probeDirectoryQueued("/b", readdir),
      probeDirectoryQueued("/c", readdir),
    ]);

    expect(outcomes).toEqual(["readable", "readable", "readable"]);
    expect(maxInFlight).toBe(1);
  });

  it("keeps the queue moving after a probe rejects", async () => {
    const first = probeDirectoryQueued("/a", async () => {
      throw fsError("EPERM");
    });
    const second = probeDirectoryQueued("/b", async () => []);
    await expect(first).resolves.toBe("privacy-blocked");
    await expect(second).resolves.toBe("readable");
  });

  it("reports pending rather than waiting forever behind a probe that never settles", async () => {
    // The blocked probe deliberately keeps its slot: a consent prompt has no
    // timeout and an abort signal cannot cancel a syscall already in flight.
    // What must not happen is the caller waiting on it indefinitely.
    void probeDirectoryQueued("/blocked", () => new Promise<never>(() => {}));
    await expect(
      probeDirectoryQueued("/behind-it", async () => [], { deadlineMs: 20 }),
    ).resolves.toBe("pending");
  });

  it("reports pending for a probe of its own that outlives the deadline", async () => {
    await expect(
      probeDirectoryQueued("/slow", () => new Promise<never>(() => {}), { deadlineMs: 20 }),
    ).resolves.toBe("pending");
  });
});
