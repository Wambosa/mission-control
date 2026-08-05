import { describe, expect, it } from "vitest";
import {
  groupScopesByKind,
  isManualRemoteSandbox,
  sandboxUsableForProject,
  scopedSandboxesForProject,
} from "../project-scoped-sandboxes";
import { LOCAL_SCOPE_ID } from "~/shared/sandbox";

const sandbox = (id: string) => ({ id, kind: "remote-vm", remoteProvider: "aws" });
const project = (id: string) => ({ id });

describe("scopedSandboxesForProject", () => {
  it("returns every sandbox when there is no current project (dashboard)", () => {
    const sandboxes = [sandbox("sb-1"), sandbox("sb-2")];
    expect(
      scopedSandboxesForProject(sandboxes, [], null, LOCAL_SCOPE_ID),
    ).toEqual(sandboxes);
  });

  it("narrows to sandboxes owned by the current project", () => {
    const result = scopedSandboxesForProject(
      [
        { id: "sb-1", kind: "remote-vm", remoteProvider: "aws", projectId: "p-local" },
        { id: "sb-2", kind: "remote-vm", remoteProvider: "aws", projectId: "p-other" },
      ],
      [],
      project("p-local"),
      LOCAL_SCOPE_ID,
    );
    expect(result.map((s) => s.id)).toEqual(["sb-1"]);
  });

  it("shows nothing extra for a local project with no sandboxes of its own", () => {
    const result = scopedSandboxesForProject(
      [{ id: "sb-2", kind: "remote-vm", remoteProvider: "aws", projectId: "p-other" }],
      [],
      project("p-local"),
      LOCAL_SCOPE_ID,
    );
    expect(result).toEqual([]);
  });

  it("includes sandboxes stamped with the current project before deployment persists", () => {
    const sandboxes = [{ id: "sb-pending", kind: "remote-vm", remoteProvider: "aws", projectId: "p-local" }];
    const result = scopedSandboxesForProject(
      sandboxes,
      [],
      project("p-local"),
      LOCAL_SCOPE_ID,
    );
    expect(result.map((s) => s.id)).toEqual(["sb-pending"]);
  });

  it("does not include an unrelated active sandbox", () => {
    const result = scopedSandboxesForProject(
      [sandbox("sb-1"), sandbox("sb-2")],
      [],
      project("p-local"),
      "sb-2",
    );
    expect(result).toEqual([]);
  });

  it("includes sibling sandboxes for the same owning project", () => {
    const result = scopedSandboxesForProject(
      [
        { id: "sb-1", kind: "remote-vm", remoteProvider: "aws", projectId: "p-local" },
        { id: "sb-2", kind: "remote-vm", remoteProvider: "aws", projectId: "p-other" },
        { id: "sb-3", kind: "remote-vm", remoteProvider: "aws", projectId: "p-local" },
      ],
      [],
      project("p-local"),
      "sb-1",
    );
    expect(result.map((s) => s.id).sort()).toEqual(["sb-1", "sb-3"]);
  });

  it("includes manually connected (provider-less) sandboxes on every project", () => {
    const result = scopedSandboxesForProject(
      [
        { id: "sb-manual", kind: "remote-vm", remoteProvider: null },
        { id: "sb-aws", kind: "remote-vm", remoteProvider: "aws", projectId: "p-other" },
      ],
      [],
      project("p-local"),
      LOCAL_SCOPE_ID,
    );
    expect(result.map((s) => s.id)).toEqual(["sb-manual"]);
  });

  it("excludes sandboxes persisted under removed managed providers", () => {
    const result = scopedSandboxesForProject(
      [{ id: "sb-legacy", kind: "remote-vm", remoteProvider: "docker", projectId: "p-local" }],
      [],
      project("p-local"),
      LOCAL_SCOPE_ID,
    );
    expect(result).toEqual([]);
  });
});

describe("sandboxUsableForProject", () => {
  it("allows a manual sandbox from any project", () => {
    const manual = { id: "sb-manual", kind: "remote-vm", remoteProvider: null };
    expect(sandboxUsableForProject(manual, "p-a")).toBe(true);
    expect(sandboxUsableForProject(manual, "p-b")).toBe(true);
    expect(isManualRemoteSandbox(manual)).toBe(true);
  });

  it("allows an AWS sandbox only for its owning project", () => {
    const aws = { id: "sb-aws", kind: "remote-vm", remoteProvider: "aws", projectId: "p-a" };
    expect(sandboxUsableForProject(aws, "p-a")).toBe(true);
    expect(sandboxUsableForProject(aws, "p-b")).toBe(false);
    expect(isManualRemoteSandbox(aws)).toBe(false);
  });
});

describe("groupScopesByKind", () => {
  const scope = (id: string, kind: string) => ({ id, kind, remoteProvider: null });

  it("keeps SSH hosts apart from sandboxes, per KD8", () => {
    const grouped = groupScopesByKind([
      scope("vm-1", "remote-vm"),
      scope("host-1", "ssh-host"),
      scope("vm-2", "remote-vm"),
    ]);

    expect(grouped.sandboxes.map((s) => s.id)).toEqual(["vm-1", "vm-2"]);
    expect(grouped.sshHosts.map((s) => s.id)).toEqual(["host-1"]);
  });

  it("preserves order within each group", () => {
    const grouped = groupScopesByKind([
      scope("host-b", "ssh-host"),
      scope("host-a", "ssh-host"),
    ]);

    expect(grouped.sshHosts.map((s) => s.id)).toEqual(["host-b", "host-a"]);
  });

  it("puts a kind it does not know with the sandboxes rather than dropping it", () => {
    const grouped = groupScopesByKind([scope("future", "warp-drive")]);

    expect(grouped.sandboxes.map((s) => s.id)).toEqual(["future"]);
    expect(grouped.sshHosts).toEqual([]);
  });

  it("handles an empty scope list", () => {
    expect(groupScopesByKind([])).toEqual({ sandboxes: [], sshHosts: [] });
  });
});
