import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("~/lib/api", () => ({
  api: {
    getGitStatus: vi.fn().mockResolvedValue({ branch: "host" }),
    getGitDiff: vi.fn().mockResolvedValue({ kind: "empty" }),
  },
}));

import { api } from "~/lib/api";
import { fetchGitStatus, fetchGitDiff } from "../project-git";

const LOCAL = { sandboxId: null, remoteDirectory: null };
const ON_HOST = { sandboxId: "sb-1", remoteDirectory: "/home/deploy/acme" };

function stub(remoteGit: Record<string, unknown>) {
  (globalThis as { window?: unknown }).window = {
    electronAPI: { sandbox: {}, remoteGit },
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.clearAllMocks();
});

describe("fetchGitStatus routing", () => {
  it("uses the HTTP API when no sandboxRepoPath is given", async () => {
    stub({ status: vi.fn() });
    const r = await fetchGitStatus("p1", null, undefined, ON_HOST);
    expect(api.getGitStatus).toHaveBeenCalledWith("p1", null);
    expect(r).toEqual({ branch: "host" });
  });

  it("uses the HTTP API for a Local project even with a repo path", async () => {
    const remoteGit = { status: vi.fn() };
    stub(remoteGit);
    await fetchGitStatus("p1", null, "/home/deploy/acme", LOCAL);
    expect(api.getGitStatus).toHaveBeenCalled();
    expect(remoteGit.status).not.toHaveBeenCalled();
  });

  it("reads a remote project's status on its own scope, backfilling behindCount", async () => {
    // The sandbox agent's git RPC doesn't compute behindCount; the router
    // normalizes the missing field to null so the GitStatus type matches runtime.
    const remoteGit = { status: vi.fn().mockResolvedValue({ branch: "sbx" }) };
    stub(remoteGit);
    const r = await fetchGitStatus("p1", null, "/home/deploy/acme", ON_HOST);
    expect(remoteGit.status).toHaveBeenCalledWith("sb-1", "/home/deploy/acme");
    expect(r).toEqual({ branch: "sbx", behindCount: null });
    expect(api.getGitStatus).not.toHaveBeenCalled();
  });

  it("defaults to the HTTP API when no scope is supplied at all", async () => {
    const remoteGit = { status: vi.fn() };
    stub(remoteGit);
    await fetchGitStatus("p1", null, "/home/deploy/acme");
    expect(api.getGitStatus).toHaveBeenCalledWith("p1", null);
    expect(remoteGit.status).not.toHaveBeenCalled();
  });
});

describe("fetchGitDiff routing", () => {
  it("reads a remote project's diff on its own scope", async () => {
    const remoteGit = { diff: vi.fn().mockResolvedValue({ kind: "text", patch: "x", truncated: false }) };
    stub(remoteGit);
    await fetchGitDiff("p1", "a.ts", false, null, "/home/deploy/acme", ON_HOST);
    expect(remoteGit.diff).toHaveBeenCalledWith("sb-1", "/home/deploy/acme", "a.ts", false);
    expect(api.getGitDiff).not.toHaveBeenCalled();
  });

  it("falls back to the HTTP API without a repo path", async () => {
    stub({ diff: vi.fn() });
    await fetchGitDiff("p1", "a.ts", false, null, undefined, ON_HOST);
    expect(api.getGitDiff).toHaveBeenCalledWith("p1", "a.ts", false, null);
  });
});
