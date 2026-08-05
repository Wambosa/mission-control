import { AGENT_CLI_CONFIG } from "../src/shared/agent-cli-config";
import type { TaskAgent } from "../src/shared/domain";
import type { SshProvisionPlan } from "../src/shared/ssh-provision";
import {
  defaultSshExec,
  shellQuote,
  sshShellArgs,
  sshStepFailure,
  type SshExec,
} from "./ssh-exec";
import { sshPrefixPrelude } from "./ssh-provision";

// Harness CLIs go into the same prefix the runtime and agent did, during first
// connect rather than on first use — the harness picker has to tell the truth
// about a host the moment it connects.
//
// A harness the probe found is the user's own and is never reinstalled or
// shadowed, so nothing here touches it. And a harness that fails to install is
// one harness the host does not offer, not a failed connect.

export type SshHarnessInstall =
  | { agent: TaskAgent; kind: "install"; label: string; script: string }
  | { agent: TaskAgent; kind: "unavailable"; reason: string };

export type SshHarnessStatus = "installed" | "failed" | "unavailable";

export type SshHarnessResult =
  | { agent: TaskAgent; status: "installed" }
  | { agent: TaskAgent; status: "failed"; error: string }
  | { agent: TaskAgent; status: "unavailable"; reason: string };

export type SshHarnessProgress = {
  agent: TaskAgent;
  index: number;
  total: number;
  status: "running" | SshHarnessStatus;
};

export type SshHarnessOptions = {
  onProgress?: (progress: SshHarnessProgress) => void;
  exec?: SshExec;
};

/**
 * npm is the only installer that can be pointed at a directory Mission Control
 * owns. A harness distributed as a shell installer writes wherever that
 * installer decides — usually `~/.local/bin` — which R8 rules out and removing
 * the host could not clean up. Such a harness is reported, not force-fitted.
 */
function harnessInstallScript(agent: TaskAgent, prefix: string): SshHarnessInstall {
  const config = AGENT_CLI_CONFIG[agent];
  if (!config.npmPackage) {
    return {
      agent,
      kind: "unavailable",
      reason: `${config.label} has no npm package to install into the prefix; its installer writes outside the directory Mission Control owns. Install it on the host yourself and Mission Control will use it as-is.`,
    };
  }

  return {
    agent,
    kind: "install",
    label: `Installing ${config.label}`,
    script: [
      sshPrefixPrelude(prefix),
      `npm install --global --prefix "$MC_PREFIX" --no-fund --no-audit ${shellQuote(`${config.npmPackage}@latest`)}`,
      "",
    ].join("\n"),
  };
}

/** What the plan's harness gaps turn into, in plan order. */
export function sshHarnessInstalls(plan: SshProvisionPlan): SshHarnessInstall[] {
  return plan.steps
    .filter((step) => step.kind === "harness")
    .map((step) => harnessInstallScript(step.agent, plan.prefix));
}

/**
 * Install each missing harness against a host, one SSH exec each. Unlike the
 * prefix sequence this does not stop at a failure: the host is still worth
 * connecting to with three harnesses instead of four.
 */
export async function installSshHarnesses(
  alias: string,
  plan: SshProvisionPlan,
  options: SshHarnessOptions = {},
): Promise<SshHarnessResult[]> {
  const exec = options.exec ?? defaultSshExec;
  const installs = sshHarnessInstalls(plan);
  const total = installs.length;
  const results: SshHarnessResult[] = [];

  for (const [index, install] of installs.entries()) {
    if (install.kind === "unavailable") {
      const result = {
        agent: install.agent,
        status: "unavailable",
        reason: install.reason,
      } as const;
      options.onProgress?.({ agent: install.agent, index, total, status: "unavailable" });
      results.push(result);
      continue;
    }

    options.onProgress?.({ agent: install.agent, index, total, status: "running" });
    const outcome = await exec(sshShellArgs(alias), install.script);
    if (outcome.code === 0) {
      options.onProgress?.({ agent: install.agent, index, total, status: "installed" });
      results.push({ agent: install.agent, status: "installed" });
    } else {
      options.onProgress?.({ agent: install.agent, index, total, status: "failed" });
      results.push({
        agent: install.agent,
        status: "failed",
        error: sshStepFailure(install.label, outcome),
      });
    }
  }

  return results;
}
