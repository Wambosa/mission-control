import { describe, expect, it } from "vitest";
import { sandboxRemoteRoot } from "../sandbox-manager";
import type { SandboxConfig } from "../sandbox-types";

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    id: "sb-1",
    kind: "remote-vm",
    imageTag: null,
    dockerfilePath: null,
    buildArgs: {},
    env: {},
    gitAuthMode: "none",
    copyAgentCreds: false,
    declaredPorts: [],
    hostAgentPort: null,
    portMap: null,
    remoteAgentUrl: null,
    pairingToken: null,
    remoteAgentCa: null,
    remoteStatus: null,
    remoteProvider: null,
    sshHost: null,
    ...overrides,
  } as SandboxConfig;
}

function sshHost(overrides: Record<string, unknown> = {}): SandboxConfig {
  return config({
    kind: "ssh-host",
    sshHost: {
      alias: "space-black",
      prefix: "/Users/admin/.mission-control",
      platform: "darwin",
      onDisconnect: "persist",
      idleWindowMinutes: 30,
      agentPort: 9333,
      workspaceRoot: null,
      ...overrides,
    },
  } as Partial<SandboxConfig>);
}

describe("sandboxRemoteRoot", () => {
  it("keeps the container layout for a Mission Control VM", () => {
    expect(sandboxRemoteRoot(config())).toBe("/workspace");
  });

  it("uses the SSH user's own home, which is where their work already is", () => {
    // /workspace is a container path. An SSH host has never had one, and the
    // agent confines itself to the user's home, so asking for /workspace was
    // both a missing directory and outside the workspace.
    expect(sandboxRemoteRoot(sshHost())).toBe("/Users/admin");
  });

  it("prefers a root the host was configured with", () => {
    expect(sandboxRemoteRoot(sshHost({ workspaceRoot: "/Volumes/work" }))).toBe("/Volumes/work");
  });

  it("derives home from the prefix, whatever the user named it", () => {
    expect(sandboxRemoteRoot(sshHost({ prefix: "/home/sam/.mission-control" }))).toBe("/home/sam");
  });

  it("reports nothing for a host with no record to derive from", () => {
    expect(sandboxRemoteRoot(sshHost({ prefix: null }))).toBeNull();
    expect(sandboxRemoteRoot(null)).toBeNull();
  });
});
