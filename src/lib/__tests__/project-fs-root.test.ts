import { describe, expect, it, vi, beforeEach } from "vitest";

const remoteRoot = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("~/lib/sandbox-runtime", () => ({
  cachedSandboxRemoteRoot: () => remoteRoot.value,
  readSandboxRuntimeMode: async () => "host" as const,
}));

const { sandboxContainerRoot } = await import("../project-fs");

describe("sandboxContainerRoot", () => {
  beforeEach(() => {
    remoteRoot.value = null;
  });

  it("falls back to the container layout before any scope has been read", () => {
    expect(sandboxContainerRoot("/home/sam/code/widget")).toBe("/workspace/widget");
  });

  it("puts a project under the active scope's own root", () => {
    // An SSH host has no /workspace; its projects sit under the user's home,
    // which is also the only place the remote agent will act.
    remoteRoot.value = "/Users/admin";

    expect(sandboxContainerRoot("/Users/admin/code/widget")).toBe("/Users/admin/widget");
  });

  it("splits a Windows project path, which never split at all before", () => {
    // "K:\\work\\hack\\mission-control" has no forward slash, so the whole
    // drive path became the project "name" and the remote cwd was nonsense.
    remoteRoot.value = "/Users/admin";

    expect(sandboxContainerRoot("K:\\work\\hack\\mission-control")).toBe(
      "/Users/admin/mission-control",
    );
  });

  it("does not double a separator when the root carries a trailing slash", () => {
    remoteRoot.value = "/Volumes/work/";

    expect(sandboxContainerRoot("/anything/widget")).toBe("/Volumes/work/widget");
  });

  it("still slugs a name the filesystem would not take", () => {
    remoteRoot.value = "/Users/admin";

    expect(sandboxContainerRoot("/src/My Project (v2)")).toBe("/Users/admin/my-project-v2");
  });
});
