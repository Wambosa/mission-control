import { describe, expect, it } from "vitest";
import { TASK_AGENTS, type TaskAgent } from "../domain";
import {
  buildSshProbeScript,
  deriveSshProvisionPlan,
  MINIMUM_REMOTE_NODE_VERSION,
  parseSshProbeOutput,
  sshPrefixPath,
  type SshProbeResult,
} from "../ssh-provision";

const EXPECTED_AGENT_VERSION = "0.3.1";

const BARE_HOST: SshProbeResult = {
  platform: "linux",
  arch: "x64",
  homeDir: "/home/sam",
  nodeVersion: null,
  agentVersion: null,
  harnessVersions: Object.fromEntries(TASK_AGENTS.map((a) => [a, null])),
};

function probe(overrides: Partial<SshProbeResult> = {}): SshProbeResult {
  return { ...BARE_HOST, ...overrides };
}

function plan(result: SshProbeResult) {
  const outcome = deriveSshProvisionPlan(result, {
    expectedAgentVersion: EXPECTED_AGENT_VERSION,
  });
  if (!outcome.ok) throw new Error(`expected a plan, got ${outcome.reason}`);
  return outcome;
}

/** Compact shape for comparing plans: `runtime`, `agent`, `harness:codex`, … */
function stepKeys(result: SshProbeResult): string[] {
  return plan(result).steps.map((step) =>
    step.kind === "harness" ? `harness:${step.agent}` : step.kind,
  );
}

describe("deriveSshProvisionPlan", () => {
  it("plans the runtime, the agent, and every harness for a bare host", () => {
    expect(stepKeys(probe())).toEqual([
      "runtime",
      "agent",
      ...TASK_AGENTS.map((a) => `harness:${a}`),
    ]);
  });

  it("omits the runtime when the host already has a usable one", () => {
    expect(stepKeys(probe({ nodeVersion: "v24.4.0" }))).not.toContain("runtime");
  });

  it("treats a runtime below the minimum as missing", () => {
    const steps = plan(probe({ nodeVersion: "v20.18.2" })).steps;
    expect(steps[0]).toEqual({ kind: "runtime", reason: "outdated", presentVersion: "v20.18.2" });
    expect(MINIMUM_REMOTE_NODE_VERSION).toBe("24.0.0");
  });

  it("omits a harness the host already has and keeps the rest", () => {
    const present: TaskAgent = "codex";
    const keys = stepKeys(
      probe({ harnessVersions: { ...BARE_HOST.harnessVersions, [present]: "0.140.0" } }),
    );
    expect(keys).not.toContain(`harness:${present}`);
    for (const agent of TASK_AGENTS.filter((a) => a !== present)) {
      expect(keys).toContain(`harness:${agent}`);
    }
  });

  it("leaves an out-of-date harness alone rather than shadowing the user's copy", () => {
    const keys = stepKeys(
      probe({ harnessVersions: { ...BARE_HOST.harnessVersions, "claude-code": "0.0.1" } }),
    );
    expect(keys).not.toContain("harness:claude-code");
  });

  it("plans nothing at all for a host that already has everything", () => {
    expect(
      stepKeys(
        probe({
          nodeVersion: "v24.4.0",
          agentVersion: EXPECTED_AGENT_VERSION,
          harnessVersions: Object.fromEntries(TASK_AGENTS.map((a) => [a, "9.9.9"])),
        }),
      ),
    ).toEqual([]);
  });

  it("replaces an agent older than the one this build speaks", () => {
    const steps = plan(probe({ nodeVersion: "v24.4.0", agentVersion: "0.2.0" })).steps;
    expect(steps).toEqual([
      { kind: "agent", reason: "outdated", presentVersion: "0.2.0" },
      ...TASK_AGENTS.map((agent) => ({ kind: "harness", agent })),
    ]);
  });

  it("derives the prefix from the SSH user's home rather than any fixed path", () => {
    expect(plan(probe({ homeDir: "/Users/sam" })).prefix).toBe("/Users/sam/.mission-control");
    expect(plan(probe({ homeDir: "/home/sam/" })).prefix).toBe("/home/sam/.mission-control");
  });

  it("accepts both target platforms and both architectures", () => {
    for (const platform of ["linux", "darwin"]) {
      for (const arch of ["x64", "arm64"]) {
        const outcome = plan(probe({ platform, arch }));
        expect(outcome).toMatchObject({ platform, arch });
      }
    }
  });

  it("refuses a Windows host instead of planning one", () => {
    const outcome = deriveSshProvisionPlan(probe({ platform: "windows" }), {
      expectedAgentVersion: EXPECTED_AGENT_VERSION,
    });
    expect(outcome).toEqual({
      ok: false,
      reason: "unsupported-platform",
      message: expect.stringMatching(/Linux and macOS/i),
    });
  });

  it("refuses an architecture with no runtime build", () => {
    const outcome = deriveSshProvisionPlan(probe({ arch: "riscv64" }), {
      expectedAgentVersion: EXPECTED_AGENT_VERSION,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "unsupported-arch" });
  });

  it("refuses a host with nowhere to install into", () => {
    const outcome = deriveSshProvisionPlan(probe({ homeDir: null }), {
      expectedAgentVersion: EXPECTED_AGENT_VERSION,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "unknown-home" });
  });

  it("honors a narrowed harness list", () => {
    const outcome = deriveSshProvisionPlan(probe({ nodeVersion: "v24.4.0" }), {
      expectedAgentVersion: EXPECTED_AGENT_VERSION,
      harnesses: ["codex"],
    });
    expect(outcome.ok && outcome.steps.filter((s) => s.kind === "harness")).toEqual([
      { kind: "harness", agent: "codex" },
    ]);
  });
});

describe("buildSshProbeScript", () => {
  it("asks about the platform, the runtime, the agent, and each harness", () => {
    const script = buildSshProbeScript();
    expect(script).toContain("uname -s");
    expect(script).toContain("uname -m");
    expect(script).toContain("mc_emit node ");
    expect(script).toContain("mc_emit agent ");
    for (const agent of TASK_AGENTS) expect(script).toContain(`mc_emit harness.${agent} `);
  });

  it("only reads — it installs nothing and touches no shell configuration", () => {
    const script = buildSshProbeScript();
    expect(script).not.toMatch(/\bsudo\b/);
    expect(script).not.toMatch(/\b(npm|pnpm|yarn|brew|apt|curl|wget|tar|install)\b/);
    expect(script).not.toMatch(/\b(mkdir|rm|cp|mv|tee|touch|chmod)\b/);
    // The only redirect is `>/dev/null`; nothing appends to a file.
    expect(script).not.toContain(">>");
    expect(script).not.toMatch(/\.bashrc|\.zshrc|\.profile/);
  });

  it("tries every command a harness may be published under", () => {
    // Cursor's CLI installs as `cursor-agent` but resolves as `agent` too.
    expect(buildSshProbeScript()).toContain("mc_version cursor-agent agent");
  });
});

describe("parseSshProbeOutput", () => {
  it("reads a full probe report", () => {
    expect(
      parseSshProbeOutput(
        [
          "platform=Darwin",
          "arch=arm64",
          "home=/Users/sam",
          "node=v24.4.0",
          "agent=0.3.1",
          "harness.claude-code=2.1.150",
          "harness.codex=",
          "harness.cursor-cli=",
          "harness.opencode=",
        ].join("\n"),
      ),
    ).toEqual({
      platform: "darwin",
      arch: "arm64",
      homeDir: "/Users/sam",
      nodeVersion: "v24.4.0",
      agentVersion: "0.3.1",
      harnessVersions: {
        "claude-code": "2.1.150",
        codex: null,
        "cursor-cli": null,
        opencode: null,
      },
    });
  });

  it("normalizes the platform and architecture names uname reports", () => {
    expect(parseSshProbeOutput("platform=Linux\narch=x86_64").platform).toBe("linux");
    expect(parseSshProbeOutput("platform=Linux\narch=x86_64").arch).toBe("x64");
    expect(parseSshProbeOutput("platform=Linux\narch=aarch64").arch).toBe("arm64");
    expect(parseSshProbeOutput("platform=MINGW64_NT-10.0\narch=x86_64").platform).toBe("windows");
  });

  it("survives an empty or noisy report without throwing", () => {
    expect(parseSshProbeOutput("")).toMatchObject({ platform: "", homeDir: null });
    expect(parseSshProbeOutput("bash: warning: setlocale failed\nplatform=Linux")).toMatchObject({
      platform: "linux",
    });
  });

  it("keeps a version string containing an equals sign intact", () => {
    expect(parseSshProbeOutput("node=v24.4.0 (build=abc)").nodeVersion).toBe("v24.4.0 (build=abc)");
  });
});

describe("sshPrefixPath", () => {
  it("puts the one directory Mission Control owns under the SSH user's home", () => {
    expect(sshPrefixPath("/home/sam")).toBe("/home/sam/.mission-control");
  });
});
