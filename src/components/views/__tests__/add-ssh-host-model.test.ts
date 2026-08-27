import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canProvision,
  describeExistingHarnesses,
  describeProvisionPlan,
  isSelectableScope,
  provisioningLabel,
  sshHostRowFromProbe,
  provisionNotes,
} from "../add-ssh-host-model";
import type { SshProbeResult, SshProvisionPlan } from "~/shared/ssh-provision";

function plan(steps: SshProvisionPlan["steps"]): SshProvisionPlan {
  return { ok: true, platform: "linux", arch: "x64", prefix: "/home/sam/.mission-control", steps };
}

const probe: SshProbeResult = {
  platform: "linux",
  arch: "x64",
  homeDir: "/home/sam",
  nodeVersion: null,
  agentVersion: null,
  harnessVersions: {},
};

describe("describeProvisionPlan", () => {
  it("says what it would install on a bare host", () => {
    const lines = describeProvisionPlan(
      plan([
        { kind: "runtime", reason: "missing", presentVersion: null },
        { kind: "agent", reason: "missing", presentVersion: null },
        { kind: "harness", agent: "codex" },
      ]),
    );

    expect(lines).toEqual([
      "Install a Node runtime",
      "Install the Mission Control agent",
      "Install Codex",
    ]);
  });

  it("distinguishes an update from a first install", () => {
    const lines = describeProvisionPlan(
      plan([{ kind: "runtime", reason: "outdated", presentVersion: "v20.1.0" }]),
    );

    expect(lines[0]).toContain("Update");
    expect(lines[0]).toContain("v20.1.0");
  });

  it("says nothing for a host that already has everything", () => {
    expect(describeProvisionPlan(plan([]))).toEqual([]);
  });
});

describe("describeExistingHarnesses", () => {
  it("names the harnesses it will leave alone (AE2)", () => {
    const existing = describeExistingHarnesses(
      plan([{ kind: "harness", agent: "codex" }, { kind: "harness", agent: "opencode" }]),
    );

    expect(existing).toContain("Claude Code");
    expect(existing).toContain("Cursor CLI");
    expect(existing).not.toContain("Codex");
    expect(existing).not.toContain("OpenCode");
  });
});

describe("sshHostRowFromProbe", () => {
  it("shows SSH's refusal and nothing that would bypass it (AE5)", () => {
    const row = sshHostRowFromProbe({
      ok: false,
      error: "SSH refused this host: host key verification failed. Resolve it with ssh yourself.",
    });

    expect(row).toMatchObject({ kind: "refused" });
    expect(row.kind === "refused" && row.message).toContain("host key verification failed");
    expect(canProvision(row)).toBe(false);
  });

  it("reports a host it cannot provision without offering to try", () => {
    const row = sshHostRowFromProbe({
      ok: true,
      probe: { ...probe, platform: "windows" },
      plan: { ok: false, reason: "unsupported-platform", message: "Mission Control runs on Linux and macOS hosts." },
    });

    expect(row).toMatchObject({ kind: "unsupported" });
    expect(canProvision(row)).toBe(false);
  });

  it("offers to provision a host it understands", () => {
    const row = sshHostRowFromProbe({
      ok: true,
      probe,
      plan: plan([{ kind: "agent", reason: "missing", presentVersion: null }]),
    });

    expect(row).toMatchObject({ kind: "ready" });
    expect(canProvision(row)).toBe(true);
    expect(row.kind === "ready" && row.summary).toEqual(["Install the Mission Control agent"]);
  });
});

describe("isSelectableScope", () => {
  it("only offers a host that has actually connected", () => {
    expect(isSelectableScope({ kind: "connected" })).toBe(true);
  });

  it("refuses a host still being provisioned", () => {
    expect(
      isSelectableScope({ kind: "provisioning", step: "Installing the Node runtime", index: 1, total: 3 }),
    ).toBe(false);
  });

  it("refuses every state that is not a live connection", () => {
    for (const state of [
      { kind: "unprobed" },
      { kind: "probing" },
      { kind: "refused", message: "no" },
      { kind: "unsupported", message: "no" },
      { kind: "failed", message: "no" },
    ] as const) {
      expect(isSelectableScope(state)).toBe(false);
    }
  });
});

describe("provisioningLabel", () => {
  it("counts steps from one, the way a person does", () => {
    expect(
      provisioningLabel({ kind: "provisioning", step: "Installing the Node runtime", index: 1, total: 3 }),
    ).toBe("Installing the Node runtime (2 of 3)");
  });

  it("has nothing to say when nothing is being provisioned", () => {
    expect(provisioningLabel({ kind: "connected" })).toBeNull();
  });
});

describe("the add-host dialog itself", () => {
  // R5's payoff is what the dialog does NOT ask for. Reaching a host over SSH
  // needs no URL, no key, and no certificate, so a field for any of them
  // reappearing is a regression worth failing on.
  const source = fs.readFileSync(
    path.join(__dirname, "..", "AddSshHostDialog.tsx"),
    "utf8",
  );

  it("asks for no agent URL, API key, or CA certificate", () => {
    expect(source).not.toMatch(/Agent URL|API key|CA certificate/i);
    expect(source).not.toMatch(/normalizeRemoteAgentUrl|generateApiKey/);
  });

  it("offers nothing that would accept a host key on the user's behalf", () => {
    expect(source).not.toMatch(/StrictHostKeyChecking|accept.*host key|trust.*anyway/i);
  });
});

describe("provisionNotes", () => {
  const clean = {
    alias: "space-black",
    adopted: false,
    survivesLogout: true,
    harnesses: [{ agent: "claude", status: "installed" as const }],
  };

  it("says nothing when a provision went perfectly, so the dialog can just close", () => {
    expect(provisionNotes(clean)).toEqual([]);
  });

  it("keeps a harness that could not be installed", () => {
    // This is the note that used to vanish as a toast while the modal closed.
    const notes = provisionNotes({
      ...clean,
      harnesses: [
        { agent: "claude", status: "installed" },
        { agent: "cursor-cli", status: "unavailable", detail: "has no npm package" },
      ],
    });

    expect(notes).toHaveLength(1);
    expect(notes[0].tone).toBe("warn");
    expect(notes[0].title).toContain("cursor-cli");
    expect(notes[0].detail).toContain("no npm package");
  });

  it("distinguishes a harness that failed from one that was never available", () => {
    const failed = provisionNotes({
      ...clean,
      harnesses: [{ agent: "codex", status: "failed", detail: "npm exited 1" }],
    });

    expect(failed[0].title).toMatch(/failed to install/);
  });

  it("leads with adoption, because it changes what removal will do", () => {
    const notes = provisionNotes({
      ...clean,
      adopted: true,
      harnesses: [{ agent: "cursor-cli", status: "unavailable" }],
    });

    expect(notes[0].tone).toBe("info");
    expect(notes[0].title).toMatch(/already running Mission Control/);
    expect(notes[0].detail).toMatch(/leave that runtime running/);
  });

  it("reports a runtime that will not survive logout", () => {
    const notes = provisionNotes({ ...clean, survivesLogout: false });

    expect(notes[0].title).toMatch(/lingering/);
  });

  it("reports a claim it could not record, since removal then gets riskier", () => {
    const notes = provisionNotes({ ...clean, claimWarning: "Read-only file system" });

    expect(notes[0].tone).toBe("warn");
    expect(notes[0].detail).toContain("Read-only file system");
  });
});
