import { describe, expect, it, vi } from "vitest";
import {
  cachedSandboxRemoteRoot,
  isRemoteProjectRuntime,
  projectRuntimeMode,
  readSandboxRemoteRoot,
} from "../sandbox-runtime";

describe("projectRuntimeMode", () => {
  it("reads the machine from the project's own scope, not a global setting", () => {
    expect(projectRuntimeMode("sb-1")).toBe("docker");
    expect(projectRuntimeMode(null)).toBe("host");
    expect(projectRuntimeMode(undefined)).toBe("host");
  });

  it("lets two projects on two machines disagree at the same time", () => {
    expect(isRemoteProjectRuntime("sb-host-a")).toBe(true);
    expect(isRemoteProjectRuntime("sb-host-b")).toBe(true);
    expect(isRemoteProjectRuntime(null)).toBe(false);
  });
});

describe("readSandboxRemoteRoot", () => {
  it("asks for the named scope's root and caches it per scope", async () => {
    const getRemoteRoot = vi
      .fn()
      .mockImplementation(async (id: string) => (id === "sb-a" ? "/home/a" : "/home/b"));
    const electron = { sandbox: { getRemoteRoot } } as never;

    await expect(readSandboxRemoteRoot("sb-a", electron)).resolves.toBe("/home/a");
    await expect(readSandboxRemoteRoot("sb-b", electron)).resolves.toBe("/home/b");
    expect(getRemoteRoot).toHaveBeenNthCalledWith(1, "sb-a");
    expect(getRemoteRoot).toHaveBeenNthCalledWith(2, "sb-b");

    // Cached per scope — neither read displaces the other.
    expect(cachedSandboxRemoteRoot("sb-a")).toBe("/home/a");
    expect(cachedSandboxRemoteRoot("sb-b")).toBe("/home/b");
    await readSandboxRemoteRoot("sb-a", electron);
    expect(getRemoteRoot).toHaveBeenCalledTimes(2);
  });

  it("has no remote root for Local, and none before a scope's first read", async () => {
    expect(cachedSandboxRemoteRoot(null)).toBeNull();
    expect(cachedSandboxRemoteRoot("sb-never-read")).toBeNull();
    await expect(readSandboxRemoteRoot(null, null)).resolves.toBeNull();
  });
});
