import { describe, expect, it } from "vitest";
import {
  DEFAULT_SSH_IDLE_WINDOW_MINUTES,
  isSandboxKind,
  normalizeRemoteAgentUrl,
  parseSandboxImageProvenance,
  parseSshHostConfig,
  SANDBOX_KINDS,
} from "../sandbox";

describe("normalizeRemoteAgentUrl", () => {
  it("normalizes HTTP(S) remote agent URLs to WebSocket URLs", () => {
    expect(normalizeRemoteAgentUrl("https://agent.example.com")).toBe("wss://agent.example.com/");
    expect(normalizeRemoteAgentUrl("http://localhost:9333")).toBe("ws://localhost:9333/");
  });

  it("accepts explicit WebSocket URLs and rejects unsupported schemes", () => {
    expect(normalizeRemoteAgentUrl("wss://agent.example.com/ws")).toBe("wss://agent.example.com/ws");
    expect(normalizeRemoteAgentUrl("ftp://agent.example.com")).toBeNull();
  });

  it("rejects remote agent URLs with embedded credentials or query secrets", () => {
    expect(normalizeRemoteAgentUrl("http://agent.example.com")).toBeNull();
    expect(normalizeRemoteAgentUrl("ws://agent.example.com")).toBeNull();
    expect(normalizeRemoteAgentUrl("http://192.168.1.10:9333")).toBeNull();
    expect(normalizeRemoteAgentUrl("https://user:pass@agent.example.com")).toBeNull();
    expect(normalizeRemoteAgentUrl("https://agent.example.com?token=secret")).toBeNull();
  });

  it("allows managed VM plaintext public WebSocket URLs when explicitly requested", () => {
    expect(normalizeRemoteAgentUrl("http://203.0.113.10:9333", { allowPlaintextPublic: true })).toBe(
      "ws://203.0.113.10:9333/",
    );
  });

  it("accepts a forwarded loopback port for an SSH host without loosening the plaintext rule", () => {
    expect(normalizeRemoteAgentUrl("ws://127.0.0.1:54321")).toBe("ws://127.0.0.1:54321/");
    expect(normalizeRemoteAgentUrl("ws://192.168.1.42:9333")).toBeNull();
  });
});

describe("sandbox kinds", () => {
  it("recognizes every declared kind and rejects anything else", () => {
    expect(SANDBOX_KINDS).toContain("ssh-host");
    for (const kind of SANDBOX_KINDS) expect(isSandboxKind(kind)).toBe(true);
    expect(isSandboxKind("local-docker")).toBe(false);
    expect(isSandboxKind(null)).toBe(false);
  });
});

describe("parseSshHostConfig", () => {
  it("reads a fully-populated SSH host record", () => {
    expect(
      parseSshHostConfig({
        agentUrl: "ws://127.0.0.1:54321/",
        ssh: {
          alias: "workshop",
          prefix: "/home/sam/.mission-control",
          platform: "linux",
          onDisconnect: "teardown",
          idleWindowMinutes: 5,
          agentPort: 9333,
          workspaceRoot: null,
        },
      }),
    ).toEqual({
      alias: "workshop",
      prefix: "/home/sam/.mission-control",
      platform: "linux",
      onDisconnect: "teardown",
      idleWindowMinutes: 5,
      agentPort: 9333,
      workspaceRoot: null,
    });
  });

  it("reports no port for a host recorded before ports were kept per-host", () => {
    // The tunnel then falls back to the client-global setting, which is what
    // every such host was already using.
    const parsed = parseSshHostConfig({
      agentUrl: "ws://127.0.0.1:54321/",
      ssh: { alias: "workshop", platform: "linux" } as never,
    });

    expect(parsed?.agentPort).toBeNull();
  });

  it("ignores a port that is not a usable TCP port", () => {
    for (const bad of [0, -1, 70000, 1.5, "9333"]) {
      const parsed = parseSshHostConfig({
        agentUrl: "ws://127.0.0.1:54321/",
        ssh: { alias: "workshop", agentPort: bad } as never,
      });
      expect(parsed?.agentPort, String(bad)).toBeNull();
    }
  });

  it("remembers which service manager a host speaks", () => {
    // Stopping or removing a host has to know whether to address launchd or
    // systemd, long after the probe that found out has gone.
    const parsed = parseSshHostConfig({
      agentUrl: "ws://127.0.0.1:54321/",
      ssh: { alias: "workshop", platform: "darwin" } as never,
    });

    expect(parsed?.platform).toBe("darwin");
  });

  it("treats a platform it cannot act on as unknown rather than guessing", () => {
    const parsed = parseSshHostConfig({
      agentUrl: "ws://127.0.0.1:54321/",
      ssh: { alias: "workshop", platform: "windows" } as never,
    });

    expect(parsed?.platform).toBeNull();
  });

  it("defaults the fields a row predating them never wrote", () => {
    expect(
      parseSshHostConfig({
        agentUrl: "ws://127.0.0.1:54321/",
        ssh: { alias: "workshop" } as never,
      }),
    ).toEqual({
      alias: "workshop",
      prefix: null,
      platform: null,
      onDisconnect: "persist",
      idleWindowMinutes: DEFAULT_SSH_IDLE_WINDOW_MINUTES,
      agentPort: null,
      workspaceRoot: null,
    });
  });

  it("falls back to the default window for a nonsense idle value", () => {
    const parsed = parseSshHostConfig({
      agentUrl: "ws://127.0.0.1:54321/",
      ssh: { alias: "workshop", idleWindowMinutes: -1 } as never,
    });
    expect(parsed?.idleWindowMinutes).toBe(DEFAULT_SSH_IDLE_WINDOW_MINUTES);
  });

  it("keeps an explicit zero window, which disables the idle stop", () => {
    const parsed = parseSshHostConfig({
      agentUrl: "ws://127.0.0.1:54321/",
      ssh: { alias: "workshop", idleWindowMinutes: 0 } as never,
    });
    expect(parsed?.idleWindowMinutes).toBe(0);
  });

  it("returns null for a remote config with no SSH host record", () => {
    expect(parseSshHostConfig({ agentUrl: "wss://agent.example.com/" })).toBeNull();
    expect(parseSshHostConfig(null)).toBeNull();
    expect(
      parseSshHostConfig({ agentUrl: "ws://127.0.0.1:1/", ssh: { alias: "  " } as never }),
    ).toBeNull();
  });
});

describe("parseSandboxImageProvenance", () => {
  it("extracts golden AMI metadata from remote_config", () => {
    expect(
      parseSandboxImageProvenance({
        agentUrl: "wss://agent.example.com/",
        image: "ami-0d7282b5efaa3b1dc",
        cloud: {
          goldenImage: true,
          imageManifestVersion: "2026.06.06-1",
          imageAgentVersion: "0.2.1",
        },
      }),
    ).toEqual({
      imageId: "ami-0d7282b5efaa3b1dc",
      goldenImage: true,
      imageManifestVersion: "2026.06.06-1",
      imageAgentVersion: "0.2.1",
    });
  });

  it("returns nulls when launch metadata is absent", () => {
    expect(parseSandboxImageProvenance({ agentUrl: "wss://agent.example.com/" })).toEqual({
      imageId: null,
      goldenImage: null,
      imageManifestVersion: null,
      imageAgentVersion: null,
    });
    expect(parseSandboxImageProvenance(null)).toEqual({
      imageId: null,
      goldenImage: null,
      imageManifestVersion: null,
      imageAgentVersion: null,
    });
  });
});
