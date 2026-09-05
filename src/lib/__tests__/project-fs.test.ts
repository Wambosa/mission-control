import { describe, it, expect, afterEach, vi } from "vitest";
import {
  projectRemoteRoot,
  sandboxContainerRoot,
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
} from "../project-fs";

function stubElectron(impl: Record<string, unknown>) {
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      // No getRemoteRoot: an older main process leaves the managed-VM
      // derivation on its /workspace default, which is what it always was.
      sandbox: {},
      ...impl,
    },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("sandboxContainerRoot", () => {
  it("derives /workspace/<slug> from the host dir basename", () => {
    expect(sandboxContainerRoot("/Users/me/code/Acme App")).toBe("/workspace/acme-app");
    expect(sandboxContainerRoot("/")).toBe("/workspace/project");
    expect(sandboxContainerRoot("/srv/my_repo/")).toBe("/workspace/my-repo");
  });
});

describe("projectRemoteRoot", () => {
  it("uses the project's configured directory verbatim", () => {
    expect(projectRemoteRoot("/Users/me/code/Acme App", "/home/deploy/acme")).toBe(
      "/home/deploy/acme",
    );
  });

  it("does not lowercase, hyphenate, or otherwise touch the configured path", () => {
    expect(projectRemoteRoot("/Users/me/code/Acme App", "/srv/Acme_App")).toBe("/srv/Acme_App");
  });

  it("trims surrounding whitespace and a trailing slash", () => {
    expect(projectRemoteRoot("/Users/me/x", "  /home/deploy/acme/  ")).toBe("/home/deploy/acme");
  });

  it("falls back to the managed-VM derivation when no directory is configured", () => {
    expect(projectRemoteRoot("/Users/me/code/Acme App", null)).toBe("/workspace/acme-app");
    expect(projectRemoteRoot("/Users/me/code/Acme App", "   ")).toBe("/workspace/acme-app");
    expect(projectRemoteRoot("/Users/me/code/Acme App")).toBe("/workspace/acme-app");
  });
});

const LOCAL = { sandboxId: null, remoteDirectory: null };
const ON_HOST = { sandboxId: "sb-1", remoteDirectory: "/home/deploy/acme" };
const ON_VM = { sandboxId: "sb-vm", remoteDirectory: null };

describe("listProjectFiles routing", () => {
  it("uses host files.list for a Local project", async () => {
    const files = { list: vi.fn().mockResolvedValue({ ok: true, files: ["a"] }) };
    const remoteFs = { list: vi.fn() };
    stubElectron({ files, remoteFs });
    const r = await listProjectFiles("/Users/me/acme", LOCAL);
    expect(files.list).toHaveBeenCalledWith("/Users/me/acme");
    expect(remoteFs.list).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, files: ["a"] });
  });

  it("lists an SSH-host project at its configured directory, on its own scope", async () => {
    const files = { list: vi.fn() };
    const remoteFs = { list: vi.fn().mockResolvedValue({ ok: true, files: ["b"] }) };
    stubElectron({ files, remoteFs });
    await listProjectFiles("/Users/me/acme", ON_HOST);
    expect(remoteFs.list).toHaveBeenCalledWith("sb-1", "/home/deploy/acme");
    expect(files.list).not.toHaveBeenCalled();
  });

  it("still derives the workspace path for a managed VM", async () => {
    const files = { list: vi.fn() };
    const remoteFs = { list: vi.fn().mockResolvedValue({ ok: true, files: ["b"] }) };
    stubElectron({ files, remoteFs });
    await listProjectFiles("/Users/me/acme", ON_VM);
    expect(remoteFs.list).toHaveBeenCalledWith("sb-vm", "/workspace/acme");
  });

  it("routes two projects on two different machines independently", async () => {
    const remoteFs = { list: vi.fn().mockResolvedValue({ ok: true, files: [] }) };
    stubElectron({ files: { list: vi.fn() }, remoteFs });
    await listProjectFiles("/Users/me/a", { sandboxId: "sb-a", remoteDirectory: "/srv/a" });
    await listProjectFiles("/Users/me/b", { sandboxId: "sb-b", remoteDirectory: "/srv/b" });
    expect(remoteFs.list).toHaveBeenNthCalledWith(1, "sb-a", "/srv/a");
    expect(remoteFs.list).toHaveBeenNthCalledWith(2, "sb-b", "/srv/b");
  });
});

describe("readProjectFile / writeProjectFile routing", () => {
  it("reads from the project's own directory on its own host", async () => {
    const files = { read: vi.fn() };
    const remoteFs = {
      read: vi.fn().mockResolvedValue({ ok: true, kind: "text", content: "", mtimeMs: 0, lineCount: 0 }),
    };
    stubElectron({ files, remoteFs });
    await readProjectFile("/Users/me/acme", "src/x.ts", ON_HOST);
    expect(remoteFs.read).toHaveBeenCalledWith("sb-1", "/home/deploy/acme/src/x.ts");
  });

  it("writes via host files.write for a Local project", async () => {
    const files = { write: vi.fn().mockResolvedValue({ ok: true, mtimeMs: 1 }) };
    const remoteFs = { write: vi.fn() };
    stubElectron({ files, remoteFs });
    await writeProjectFile("/Users/me/acme", "src/x.ts", "hi", 5, LOCAL);
    expect(files.write).toHaveBeenCalledWith("/Users/me/acme", "src/x.ts", "hi", 5);
    expect(remoteFs.write).not.toHaveBeenCalled();
  });

  it("returns a not-electron error when the bridge is absent", async () => {
    delete (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {};
    const r = await listProjectFiles("/x", LOCAL);
    expect(r.ok).toBe(false);
  });
});
