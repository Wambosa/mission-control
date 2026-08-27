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
 * Harnesses that ship a shell installer instead of an npm package.
 *
 * Such an installer decides its own destination, which is why these used to be
 * reported as unavailable and left for the user — telling someone to go and
 * install something by hand is most of the friction in connecting a host.
 *
 * But these installers place everything relative to `$HOME`, so giving one a
 * `$HOME` inside the prefix puts its whole tree inside the prefix. Nothing
 * lands in the user's own `~/.local`, removing the host is still `rm -rf` on
 * one directory, and the binary reaches sessions through a symlink in
 * `<prefix>/bin` — which the service PATH already searches first.
 *
 * At run time the harness gets the user's real `$HOME`; only installation is
 * redirected, so logins and config stay where the user expects them.
 */
/** Printed by an update that found no prefix copy of its own to update. */
const NOT_OURS = "mc:not-installed-by-us";

const SHELL_INSTALLERS: Partial<Record<TaskAgent, { url: string; binaries: string[] }>> = {
  // Installs to $HOME/.local/share/cursor-agent/versions/<v>, symlinked from
  // $HOME/.local/bin as both `agent` and `cursor-agent`.
  "cursor-cli": { url: "https://cursor.com/install", binaries: ["cursor-agent", "agent"] },
};

/** Install a shell-distributed harness into a `$HOME` inside the prefix. */
function shellInstallerScript(
  prefix: string,
  installer: { url: string; binaries: string[] },
): string {
  const lines = [
    sshPrefixPrelude(prefix),
    `mc_home="$MC_PREFIX/cursor"`,
    `mkdir -p "$mc_home"`,
    // Same fetch shape the runtime step uses: a host has one of these, not both.
    `mc_fetch() {`,
    `  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"`,
    `  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"`,
    `  else echo "this host has neither curl nor wget" >&2; return 1`,
    `  fi`,
    `}`,
    // The installer is a bash script, not a POSIX one.
    `if ! command -v bash >/dev/null 2>&1; then echo "this host has no bash to run the installer" >&2; exit 1; fi`,
    `mc_fetch ${shellQuote(installer.url)} > "$mc_home/install.sh"`,
    `HOME="$mc_home" bash "$mc_home/install.sh" >/dev/null 2>&1 || true`,
    `rm -f "$mc_home/install.sh"`,
  ];
  for (const binary of installer.binaries) {
    lines.push(
      `if [ -e "$mc_home/.local/bin/${binary}" ]; then ln -sf "$mc_home/.local/bin/${binary}" "$MC_PREFIX/bin/${binary}"; fi`,
    );
  }
  // The installer's own exit code is not trustworthy enough to rely on; what
  // matters is whether the binary is there and reachable.
  const primary = installer.binaries[0];
  lines.push(
    `if [ ! -e "$MC_PREFIX/bin/${primary}" ]; then echo "the installer ran but left no ${primary} in the prefix" >&2; exit 1; fi`,
    "",
  );
  return lines.join("\n");
}

/**
 * npm is the installer that can be pointed straight at a directory Mission
 * Control owns. A harness distributed as a shell installer is redirected into
 * the prefix instead (see {@link SHELL_INSTALLERS}); one that offers neither is
 * reported rather than force-fitted.
 */
export function harnessInstallScript(agent: TaskAgent, prefix: string): SshHarnessInstall {
  const config = AGENT_CLI_CONFIG[agent];
  const installer = SHELL_INSTALLERS[agent];
  if (!config.npmPackage && installer) {
    return {
      agent,
      kind: "install",
      label: `Installing ${config.label}`,
      script: shellInstallerScript(prefix, installer),
    };
  }
  if (!config.npmPackage) {
    return {
      agent,
      kind: "unavailable",
      reason: `${config.label} has no npm package and no installer Mission Control can redirect into the prefix. Install it on the host yourself and Mission Control will use it as-is.`,
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

export type SshHarnessUpdate =
  | { ok: true; version: string | null }
  | { ok: false; reason: "no-update-command" }
  | { ok: false; reason: "failed"; output: string };

/**
 * Update a harness on a host, in that host's own prefix. Installing `@latest`
 * over the prefix copy *is* the update — the prefix is Mission Control's, so
 * there is nothing of the user's to disturb.
 *
 * A harness with no npm package was never installed into the prefix (see
 * {@link harnessInstallScript}), so there is nothing here to update and the
 * user's own copy is not ours to touch.
 */
export async function updateSshHarness(
  alias: string,
  agent: TaskAgent,
  prefix: string,
  exec: SshExec = defaultSshExec,
): Promise<SshHarnessUpdate> {
  const install = harnessInstallScript(agent, prefix);
  if (install.kind !== "install") return { ok: false, reason: "no-update-command" };

  const config = AGENT_CLI_CONFIG[agent];
  // Only ever update a copy Mission Control put there. Running a shell
  // installer against a host where the harness is the user's own would plant a
  // second copy in the prefix and shadow theirs on the service PATH — the one
  // thing this module promises not to do. npm harnesses carry no such risk:
  // `--prefix` already scopes them, and a prefix copy is by definition ours.
  const guard = SHELL_INSTALLERS[agent]
    ? `if [ ! -e ${shellQuote(`${prefix}/bin/${config.command}`)} ]; then printf '%s\\n' "${NOT_OURS}"; exit 0; fi\n`
    : "";
  // Report the version back in the same round trip, read through the prefix
  // PATH so it is the host's copy that answers, never this machine's.
  const script = `${guard}${install.script}${shellQuote(`${prefix}/bin/${config.command}`)} --version 2>/dev/null | head -n 1 || true\n`;
  const result = await exec(sshShellArgs(alias), script);
  if (result.code !== 0) {
    return { ok: false, reason: "failed", output: sshStepFailure(install.label, result) };
  }
  if (result.stdout.includes(NOT_OURS)) return { ok: false, reason: "no-update-command" };
  return { ok: true, version: result.stdout.trim() || null };
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
