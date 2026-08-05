import { EXPECTED_SANDBOX_AGENT_VERSION } from "./sandbox-types";
import {
  defaultSshExec,
  shellQuote,
  sshShellArgs,
  sshStepFailure,
  type SshExec,
} from "./ssh-exec";
import {
  REMOTE_AGENT_COMMAND,
  REMOTE_AGENT_PACKAGE,
  type SshHostArch,
  type SshHostPlatform,
  type SshProvisionPlan,
} from "../src/shared/ssh-provision";

// The install half of first connect. Everything Mission Control lays down goes
// under one directory the SSH user already owns, so provisioning needs no root,
// installs nothing globally, and touches no shell configuration — removing the
// host is `rm -rf` on that one directory and nothing else.
//
// The generated command strings are the artifact worth testing. A step is a
// self-contained POSIX script; running it is one SSH exec, and the sequence
// stops at the first one that fails.

/** Node's per-major channel. Answers "which build the runtime fetch pulls from". */
const NODE_CHANNEL = "https://nodejs.org/dist/latest-v24.x";

/**
 * Node publishes `.tar.xz` too, and it is much smaller — but extracting it
 * needs `xz` on the host, which a minimal Linux image often lacks. `.tar.gz`
 * costs bandwidth once and keeps the host requirement at "a shell and tar".
 */
const NODE_ARCHIVE_EXT = "tar.gz";

export type SshProvisionCommand = {
  /** Stable id, so a caller can say which step failed. */
  id: "prefix" | "runtime" | "agent";
  /** Shown by the provisioning UI while the step runs. */
  label: string;
  /** A POSIX script, run over one `sh -s`. */
  script: string;
};

export type SshProvisionProgress = {
  command: SshProvisionCommand;
  /** 0-based position in the sequence. */
  index: number;
  total: number;
  status: "running" | "done" | "failed";
};

export type SshProvisionRunResult =
  | { ok: true; prefix: string }
  | { ok: false; failedStep: SshProvisionCommand["id"]; error: string };

export type SshProvisionOptions = {
  /** The agent version this build of Mission Control speaks. */
  agentVersion?: string;
  onProgress?: (progress: SshProvisionProgress) => void;
  exec?: SshExec;
};

/** Directories inside the prefix, relative to it. */
export const SSH_PREFIX_BIN = "bin";
export const SSH_PREFIX_RUNTIME = "runtime";
export const SSH_PREFIX_SERVICE = "service";
const SSH_PREFIX_LOG = "log";
const SSH_PREFIX_TMP = "tmp";
const SSH_PREFIX_NPM_CACHE = "npm-cache";

/**
 * Shared by every step: fail loudly, keep the prefix on PATH so a runtime this
 * sequence installed is the one later steps use, and keep npm's cache inside
 * the prefix so removing the host leaves nothing behind.
 */
export function sshPrefixPrelude(prefix: string): string {
  const quoted = shellQuote(prefix);
  return [
    "set -eu",
    `MC_PREFIX=${quoted}`,
    `PATH="$MC_PREFIX/${SSH_PREFIX_BIN}:$MC_PREFIX/${SSH_PREFIX_RUNTIME}/${SSH_PREFIX_BIN}:$PATH"`,
    "export PATH",
    `npm_config_cache="$MC_PREFIX/${SSH_PREFIX_NPM_CACHE}"`,
    "npm_config_update_notifier=false",
    "export npm_config_cache npm_config_update_notifier",
  ].join("\n");
}

function createPrefixScript(prefix: string): string {
  const dirs = [SSH_PREFIX_BIN, SSH_PREFIX_SERVICE, SSH_PREFIX_LOG]
    .map((dir) => `"$MC_PREFIX/${dir}"`)
    .join(" ");
  return [
    sshPrefixPrelude(prefix),
    // 0700: the service env file under here holds the host's bearer secret.
    `mkdir -p ${dirs}`,
    `chmod 700 "$MC_PREFIX"`,
    "",
  ].join("\n");
}

/**
 * Fetch a Node build for the probed platform and architecture rather than
 * asking a package manager, which would want root and would install globally.
 * The channel's own `SHASUMS256.txt` names the current build and verifies the
 * download, so nothing here pins a version that would rot.
 */
function installRuntimeScript(prefix: string, platform: SshHostPlatform, arch: SshHostArch): string {
  // The probe already normalizes to the names Node uses in a release filename.
  const slug = `${platform}-${arch}`;
  return [
    sshPrefixPrelude(prefix),
    `mc_fetch() {`,
    `  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"`,
    `  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"`,
    `  else echo "this host has neither curl nor wget, so the runtime cannot be fetched" >&2; return 1`,
    `  fi`,
    `}`,
    `mc_tmp="$MC_PREFIX/${SSH_PREFIX_TMP}"`,
    `rm -rf "$mc_tmp"`,
    `mkdir -p "$mc_tmp"`,
    `mc_fetch ${shellQuote(`${NODE_CHANNEL}/SHASUMS256.txt`)} > "$mc_tmp/SHASUMS256.txt"`,
    // The channel index is the only place the current build number appears.
    `mc_file=$(sed -n 's/^[0-9a-f]\\{64\\}  \\(node-v24\\.[0-9.]*-${slug}\\.${NODE_ARCHIVE_EXT.replace(".", "\\.")}\\)$/\\1/p' "$mc_tmp/SHASUMS256.txt" | head -n 1)`,
    `if [ -z "$mc_file" ]; then echo "no Node build published for ${slug}" >&2; exit 1; fi`,
    `mc_fetch "${NODE_CHANNEL}/$mc_file" > "$mc_tmp/$mc_file"`,
    // A tarball piped straight into tar is a tarball nobody checked.
    `cd "$mc_tmp"`,
    `grep -F "  $mc_file" SHASUMS256.txt | head -n 1 > node.sha256`,
    `if command -v sha256sum >/dev/null 2>&1; then sha256sum -c node.sha256`,
    `elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -c node.sha256`,
    `else echo "this host has no sha256 tool, so the runtime download cannot be verified" >&2; exit 1`,
    `fi`,
    `rm -rf "$MC_PREFIX/${SSH_PREFIX_RUNTIME}"`,
    `mkdir -p "$MC_PREFIX/${SSH_PREFIX_RUNTIME}"`,
    `tar -xzf "$mc_tmp/$mc_file" -C "$MC_PREFIX/${SSH_PREFIX_RUNTIME}" --strip-components=1`,
    `rm -rf "$mc_tmp"`,
    `"$MC_PREFIX/${SSH_PREFIX_RUNTIME}/${SSH_PREFIX_BIN}/node" --version`,
    "",
  ].join("\n");
}

/**
 * npm's `--global` means "global to the prefix", and the prefix here is the one
 * directory Mission Control owns. Nothing lands outside it, and no other npm
 * install on the host is touched.
 */
function installAgentScript(prefix: string, agentVersion: string): string {
  return [
    sshPrefixPrelude(prefix),
    `npm install --global --prefix "$MC_PREFIX" --no-fund --no-audit ${shellQuote(`${REMOTE_AGENT_PACKAGE}@${agentVersion}`)}`,
    `if [ ! -x "$MC_PREFIX/${SSH_PREFIX_BIN}/${REMOTE_AGENT_COMMAND}" ]; then`,
    `  echo "${REMOTE_AGENT_COMMAND} is not in the prefix after install" >&2`,
    `  exit 1`,
    `fi`,
    // node-pty forks through a small helper binary its published tarball does
    // not mark executable. Without this the agent installs, starts, and then
    // fails on the first PTY — which is the only thing a session is.
    `find "$MC_PREFIX/lib/node_modules" -name spawn-helper -type f -exec chmod +x {} + 2>/dev/null || true`,
    // Opening one throwaway PTY is the difference between "the package is on
    // disk" and "this host can run a session". A Linux host with no compiler
    // for node-pty's native build fails here, by name, rather than at first use.
    `mc_agent_dir="$MC_PREFIX/lib/node_modules/${REMOTE_AGENT_PACKAGE}"`,
    `if ! mc_pty=$(node -e 'const d=process.argv[1];const pty=require(require.resolve("node-pty",{paths:[d]}));pty.spawn("/bin/echo",["ok"],{name:"xterm-color",cols:80,rows:24}).kill();' "$mc_agent_dir" 2>&1); then`,
    `  echo "the agent installed but cannot open a PTY on this host: $mc_pty" >&2`,
    `  exit 1`,
    `fi`,
    "",
  ].join("\n");
}

/**
 * The steps that lay down the prefix itself. Harness CLIs ride the same prefix
 * but install separately, so one that fails does not fail the connect.
 */
export function sshProvisionCommands(
  plan: SshProvisionPlan,
  options: { agentVersion?: string } = {},
): SshProvisionCommand[] {
  const agentVersion = options.agentVersion ?? EXPECTED_SANDBOX_AGENT_VERSION;
  const commands: SshProvisionCommand[] = [
    {
      id: "prefix",
      label: "Creating the Mission Control directory",
      script: createPrefixScript(plan.prefix),
    },
  ];

  if (plan.steps.some((step) => step.kind === "runtime")) {
    commands.push({
      id: "runtime",
      label: "Installing the Node runtime",
      script: installRuntimeScript(plan.prefix, plan.platform, plan.arch),
    });
  }
  if (plan.steps.some((step) => step.kind === "agent")) {
    commands.push({
      id: "agent",
      label: "Installing the Mission Control agent",
      script: installAgentScript(plan.prefix, agentVersion),
    });
  }
  return commands;
}

/**
 * Walk the sequence against a host, one SSH exec per step. A step that fails
 * stops the run and names itself, because a half-built prefix is worth
 * reporting rather than papering over.
 */
export async function runSshProvision(
  alias: string,
  plan: SshProvisionPlan,
  options: SshProvisionOptions = {},
): Promise<SshProvisionRunResult> {
  const exec = options.exec ?? defaultSshExec;
  const commands = sshProvisionCommands(plan, { agentVersion: options.agentVersion });
  const total = commands.length;

  for (const [index, command] of commands.entries()) {
    options.onProgress?.({ command, index, total, status: "running" });
    const result = await exec(sshShellArgs(alias), command.script);
    if (result.code !== 0) {
      options.onProgress?.({ command, index, total, status: "failed" });
      return { ok: false, failedStep: command.id, error: sshStepFailure(command.label, result) };
    }
    options.onProgress?.({ command, index, total, status: "done" });
  }

  return { ok: true, prefix: plan.prefix };
}
