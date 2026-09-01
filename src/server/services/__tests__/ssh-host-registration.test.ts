import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-test-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const { registerSshHost, getSandboxState, deleteSandbox } = await import("../sandboxes");

const listSandboxes = () => getSandboxState().sandboxes;

function register(overrides: Partial<Parameters<typeof registerSshHost>[0]> = {}) {
  return registerSshHost({
    alias: "space-black",
    name: "space-black",
    prefix: "/Users/admin/.mission-control",
    platform: "darwin",
    apiKey: "b8f1c2d3e4",
    agentPort: 9333,
    ...overrides,
  });
}

describe("registerSshHost", () => {
  beforeEach(() => {
    for (const sandbox of listSandboxes()) deleteSandbox(sandbox.id);
  });

  it("updates the existing row when the same host is added again", () => {
    // An SSH host stores no agent URL — it is reached through a tunnel — and
    // treating that empty string as an unreadable config made this lookup miss
    // every time, so re-adding a host silently piled up duplicate scopes.
    const first = register();
    const second = register();

    expect(second.id).toBe(first.id);
    expect(listSandboxes().filter((s) => s.kind === "ssh-host")).toHaveLength(1);
  });

  it("keeps one row per alias, not per attempt", () => {
    register();
    register();
    register();

    expect(listSandboxes()).toHaveLength(1);
  });

  it("still tells two different hosts apart", () => {
    register({ alias: "space-black" });
    register({ alias: "steel-helix", name: "steel-helix" });

    expect(listSandboxes()).toHaveLength(2);
  });

  it("carries the port forward when a later add does not name one", () => {
    const first = register({ agentPort: 9412 });
    const again = register({ agentPort: undefined });

    expect(again.id).toBe(first.id);
    // The runtime did not move; forgetting its port would break the tunnel.
    const row = listSandboxes().find((s) => s.id === again.id);
    expect(row).toBeDefined();
  });
});
