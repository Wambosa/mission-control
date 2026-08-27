import { describe, expect, it } from "vitest";
import {
  SSH_SERVICE_LABEL,
  sshServiceDefinition,
  sshServicePath,
  type SshServiceDescription,
} from "../ssh-service-unit";

function description(overrides: Partial<SshServiceDescription> = {}): SshServiceDescription {
  return {
    platform: "linux",
    homeDir: "/home/sam",
    prefix: "/home/sam/.mission-control",
    agentPort: 9333,
    apiKey: "b8f1c2d3e4",
    agentVersion: "1.2.3",
    ...overrides,
  };
}

const mac = () =>
  description({ platform: "darwin", homeDir: "/Users/ada", prefix: "/Users/ada/.mission-control" });

/** The rendered unit, whichever platform it is for. */
function unit(desc: SshServiceDescription): string {
  const definition = sshServiceDefinition(desc);
  return definition.files.find((file) => file.path === definition.unitPath)!.contents;
}

/**
 * One environment variable off a rendered unit, whichever way that platform
 * spells it — `Environment=KEY=value` for systemd, a key/string pair for
 * launchd. Lets a scenario assert the setting rather than the syntax.
 */
function serviceEnv(desc: SshServiceDescription, key: string): string | null {
  const rendered = unit(desc);
  if (desc.platform === "darwin") {
    const match = rendered.match(
      new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
    );
    return match ? match[1] : null;
  }
  const match = rendered.match(new RegExp(`^Environment=${key}=(.*)$`, "m"));
  return match ? match[1] : null;
}

describe("sshServiceDefinition", () => {
  it("keeps the macOS agent alive across exit and reboot", () => {
    const plist = unit(mac());

    expect(plist).toContain(`<key>Label</key>`);
    expect(plist).toContain(SSH_SERVICE_LABEL);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it("restarts the Linux unit on failure and enables it for the user", () => {
    const service = unit(description());

    expect(service).toContain("Restart=always");
    // A user unit is wanted by the user's own default target, not multi-user.
    expect(service).toContain("WantedBy=default.target");
    expect(service).not.toContain("multi-user.target");
  });

  it("puts the prefix binary directory on the service PATH on both platforms", () => {
    // This PATH entry is the whole reason a prefix-installed harness is
    // selectable for sessions on the host.
    expect(serviceEnv(description(), "PATH")?.split(":")[0]).toBe(
      "/home/sam/.mission-control/bin",
    );
    expect(serviceEnv(mac(), "PATH")?.split(":")[0]).toBe("/Users/ada/.mission-control/bin");
    expect(serviceEnv(description(), "PATH")).toBe(sshServicePath(description()));
  });

  it("binds the runtime to loopback and names no network address", () => {
    for (const desc of [description(), mac()]) {
      expect(serviceEnv(desc, "MC_AGENT_BIND_HOST")).toBe("127.0.0.1");
      expect(unit(desc)).not.toContain("0.0.0.0");
      expect(unit(desc)).not.toMatch(/BIND_HOST[^\n]*::/);
    }
  });

  it("keeps the bearer secret out of the unit and in a file only the user can read", () => {
    for (const desc of [description(), mac()]) {
      const definition = sshServiceDefinition(desc);
      expect(unit(desc)).not.toContain(desc.apiKey);
      const envFile = definition.files.find((file) => file.contents.includes(desc.apiKey))!;
      expect(envFile.mode).toBe("600");
      expect(envFile.path.startsWith(desc.prefix)).toBe(true);
    }
  });

  it("registers where each platform's own service manager looks", () => {
    expect(sshServiceDefinition(mac()).unitPath).toBe(
      `/Users/ada/Library/LaunchAgents/${SSH_SERVICE_LABEL}.plist`,
    );
    expect(sshServiceDefinition(description()).unitPath).toBe(
      "/home/sam/.config/systemd/user/mission-control-agent.service",
    );
  });

  it("renders the same bytes for the same host", () => {
    expect(sshServiceDefinition(description())).toEqual(sshServiceDefinition(description()));
    expect(sshServiceDefinition(mac())).toEqual(sshServiceDefinition(mac()));
  });

  it("confines the runtime to the SSH user's own home", () => {
    expect(serviceEnv(description(), "MC_WORKSPACE_ROOT")).toBe("/home/sam");
    expect(serviceEnv(mac(), "MC_WORKSPACE_ROOT")).toBe("/Users/ada");
  });

  it("escapes a home directory the user was free to name", () => {
    const awkward = sshServiceDefinition(
      description({ platform: "darwin", homeDir: "/Users/a&b", prefix: "/Users/a&b/.mc" }),
    );
    const plist = awkward.files.find((file) => file.path === awkward.unitPath)!.contents;

    expect(plist).toContain("/Users/a&amp;b");
    expect(plist).not.toMatch(/\/Users\/a&b/);
  });
});

describe("workspace root", () => {
  it("confines the runtime to the SSH user's home by default", () => {
    expect(serviceEnv(description(), "MC_WORKSPACE_ROOT")).toBe("/home/sam");
  });

  it("uses a root the host was configured with instead", () => {
    // A host may keep its work on another volume; confining the runtime to
    // $HOME would put those projects out of reach.
    const desc = description({ workspaceRoot: "/Volumes/work" });

    expect(serviceEnv(desc, "MC_WORKSPACE_ROOT")).toBe("/Volumes/work");
  });

  it("falls back to home for a blank or absent root", () => {
    expect(serviceEnv(description({ workspaceRoot: "   " }), "MC_WORKSPACE_ROOT")).toBe("/home/sam");
    expect(serviceEnv(description({ workspaceRoot: null }), "MC_WORKSPACE_ROOT")).toBe("/home/sam");
  });

  it("trims a trailing slash so the value matches what the agent compares against", () => {
    expect(serviceEnv(description({ workspaceRoot: "/srv/code/" }), "MC_WORKSPACE_ROOT")).toBe(
      "/srv/code",
    );
  });

  it("carries the root onto macOS too", () => {
    const desc = description({
      platform: "darwin",
      homeDir: "/Users/ada",
      prefix: "/Users/ada/.mission-control",
      workspaceRoot: "/Volumes/work",
    });

    expect(serviceEnv(desc, "MC_WORKSPACE_ROOT")).toBe("/Volumes/work");
  });
});
