import { AGENT_CLI_CONFIG, pathLookupCandidates } from "./agent-cli-config";
import { compareCliVersions, extractCliVersion } from "./agent-cli-version-compare";
import { TASK_AGENTS, type TaskAgent } from "./domain";

// What a host already has, and what it therefore needs. Mission Control assumes
// nothing but a shell on the far side, so it looks before it installs — and an
// installation the host already has is left exactly where the user put it.
//
// Everything here is pure: the probe script is a string, the probe output is
// text, and the plan is a function of the two. The SSH hop lives elsewhere.

/** Target platforms. Windows as a target host is out of scope. */
export const SSH_TARGET_PLATFORMS = ["linux", "darwin"] as const;
export type SshHostPlatform = (typeof SSH_TARGET_PLATFORMS)[number];

/** Architectures the runtime fetch has builds for. */
export const SSH_TARGET_ARCHS = ["x64", "arm64"] as const;
export type SshHostArch = (typeof SSH_TARGET_ARCHS)[number];

/** The remote agent package declares `node >= 24`. */
export const MINIMUM_REMOTE_NODE_VERSION = "24.0.0";

/** The command the remote agent publishes on PATH. */
export const REMOTE_AGENT_COMMAND = "mission-control-agent";

/** The npm package that publishes {@link REMOTE_AGENT_COMMAND}. */
export const REMOTE_AGENT_PACKAGE = "@agentsystemlabs/mission-control-agent";

/** Everything one probe reports back. A null means "not found". */
export type SshProbeResult = {
  /** Lowercased `uname -s`, e.g. `linux` or `darwin`. */
  platform: string;
  /** Normalized `uname -m`, e.g. `x64` or `arm64`. */
  arch: string;
  /** The SSH user's home directory, as the host reports it. */
  homeDir: string | null;
  /** `node --version`, or null when the host has no node on PATH. */
  nodeVersion: string | null;
  /** The remote agent's version, or null when it isn't installed. */
  agentVersion: string | null;
  /** Version per harness CLI found on PATH; null when absent. */
  harnessVersions: Partial<Record<TaskAgent, string | null>>;
};

export type SshProvisionReason = "missing" | "outdated";

export type SshProvisionStep =
  | { kind: "runtime"; reason: SshProvisionReason; presentVersion: string | null }
  | { kind: "agent"; reason: SshProvisionReason; presentVersion: string | null }
  // A harness step only ever exists because the host has no copy at all; one it
  // already has is used as-is, whatever version it happens to be.
  | { kind: "harness"; agent: TaskAgent };

export type SshProvisionPlan = {
  ok: true;
  platform: SshHostPlatform;
  arch: SshHostArch;
  /** Where everything Mission Control installs will land. */
  prefix: string;
  /** Empty when the host already has everything. */
  steps: SshProvisionStep[];
};

export type SshUnsupportedHost = {
  ok: false;
  reason: "unsupported-platform" | "unsupported-arch" | "unknown-home";
  message: string;
};

export type SshProvisionOutcome = SshProvisionPlan | SshUnsupportedHost;

/** What one probe of a host produced, or why it could not be reached. */
export type SshProbeOutcome =
  | { ok: true; probe: SshProbeResult; plan: SshProvisionOutcome }
  | { ok: false; error: string };

/**
 * What provisioning a host produced, or why it stopped. The caller records the
 * result as a scope; the API key was generated here and the user never sees,
 * types, or pastes it — that absence is the point of R5.
 */
export type SshProvisionResult =
  | {
      ok: true;
      alias: string;
      /** The one directory Mission Control owns on the host. */
      prefix: string;
      platform: SshHostPlatform;
      apiKey: string;
      /** Per-harness outcome; one that failed did not fail the host. */
      harnesses: Array<{
        agent: TaskAgent;
        status: "installed" | "failed" | "unavailable";
        detail?: string;
      }>;
      /** False when the runtime will not survive the user logging out of the host. */
      survivesLogout: boolean;
    }
  | { ok: false; error: string };

export type SshProvisionRequirements = {
  /** The agent version this build of Mission Control speaks. */
  expectedAgentVersion: string;
  /** Overridable for tests; defaults to what the agent package declares. */
  minimumNodeVersion?: string;
  /** Harnesses to make available. Defaults to every managed one. */
  harnesses?: readonly TaskAgent[];
};

/**
 * The one directory Mission Control owns on a host. Everything it installs
 * lands beneath it, and removing the host deletes it — so it is derived from
 * the SSH user's own home rather than any absolute location.
 */
export function sshPrefixPath(homeDir: string): string {
  return `${homeDir.replace(/\/+$/, "")}/.mission-control`;
}

/**
 * POSIX single-quoting. Every host path Mission Control interpolates into a
 * script goes through here, because a home directory is the user's to name.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizePlatform(uname: string): string {
  const value = uname.trim().toLowerCase();
  if (value === "darwin") return "darwin";
  if (value === "linux") return "linux";
  // MSYS/Cygwin/MinGW all report a Windows kernel under a different banner.
  if (/mingw|msys|cygwin|windows/.test(value)) return "windows";
  return value;
}

function normalizeArch(uname: string): string {
  const value = uname.trim().toLowerCase();
  if (value === "x86_64" || value === "amd64" || value === "x64") return "x64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  return value;
}

function isTargetPlatform(value: string): value is SshHostPlatform {
  return (SSH_TARGET_PLATFORMS as readonly string[]).includes(value);
}

function isTargetArch(value: string): value is SshHostArch {
  return (SSH_TARGET_ARCHS as readonly string[]).includes(value);
}

/** The commands the probe asks about for one harness, in PATH-lookup order. */
function harnessProbeCommands(agent: TaskAgent): readonly string[] {
  return pathLookupCandidates(AGENT_CLI_CONFIG[agent].command);
}

// ── The probe ──────────────────────────────────────────────────────────────

/**
 * A read-only POSIX shell script. It installs nothing, writes nothing, and
 * touches no shell configuration — it only reports what is already there.
 * Emits `key=value` lines so the parser stays trivial.
 */
export function buildSshProbeScript(harnesses: readonly TaskAgent[] = TASK_AGENTS): string {
  const lines = [
    "set -u",
    // First candidate that exists wins, matching local PATH resolution.
    'mc_version() { for c in "$@"; do if command -v "$c" >/dev/null 2>&1; then "$c" --version 2>/dev/null | head -n 1; return 0; fi; done; }',
    'mc_emit() { printf "%s=%s\\n" "$1" "$2"; }',
    'mc_emit platform "$(uname -s 2>/dev/null || echo unknown)"',
    'mc_emit arch "$(uname -m 2>/dev/null || echo unknown)"',
    'mc_emit home "${HOME:-}"',
    'mc_emit node "$(mc_version node)"',
    `mc_emit agent "$(mc_version ${REMOTE_AGENT_COMMAND})"`,
  ];
  for (const agent of harnesses) {
    lines.push(`mc_emit harness.${agent} "$(mc_version ${harnessProbeCommands(agent).join(" ")})"`);
  }
  return `${lines.join("\n")}\n`;
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Parse the probe's `key=value` output. Unknown keys are ignored. */
export function parseSshProbeOutput(stdout: string): SshProbeResult {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1));
  }

  const harnessVersions: Partial<Record<TaskAgent, string | null>> = {};
  for (const agent of TASK_AGENTS) {
    const raw = fields.get(`harness.${agent}`);
    // Absent key and empty value differ: one was never asked, one found nothing.
    if (raw === undefined) continue;
    harnessVersions[agent] = blankToNull(raw);
  }

  return {
    platform: normalizePlatform(fields.get("platform") ?? ""),
    arch: normalizeArch(fields.get("arch") ?? ""),
    homeDir: blankToNull(fields.get("home") ?? ""),
    nodeVersion: blankToNull(fields.get("node") ?? ""),
    agentVersion: blankToNull(fields.get("agent") ?? ""),
    harnessVersions,
  };
}

// ── The plan ───────────────────────────────────────────────────────────────

function versionAtLeast(reported: string | null, minimum: string): boolean {
  if (!reported) return false;
  const version = extractCliVersion(reported);
  if (!version) return false;
  return compareCliVersions(version, minimum) >= 0;
}

/**
 * Turn what the host has into what Mission Control must install. A harness
 * already on PATH is satisfied and is never reinstalled or shadowed; a runtime
 * too old to run the agent counts as missing, because it cannot do the job.
 */
export function deriveSshProvisionPlan(
  probe: SshProbeResult,
  requirements: SshProvisionRequirements,
): SshProvisionOutcome {
  if (!isTargetPlatform(probe.platform)) {
    return {
      ok: false,
      reason: "unsupported-platform",
      message: `Mission Control runs on Linux and macOS hosts. This host reported "${probe.platform || "an unknown platform"}".`,
    };
  }
  if (!isTargetArch(probe.arch)) {
    return {
      ok: false,
      reason: "unsupported-arch",
      message: `Mission Control has no runtime build for this host's architecture ("${probe.arch || "unknown"}").`,
    };
  }
  if (!probe.homeDir) {
    return {
      ok: false,
      reason: "unknown-home",
      message: "The SSH user has no home directory, so there is nowhere to install into.",
    };
  }

  const minimumNode = requirements.minimumNodeVersion ?? MINIMUM_REMOTE_NODE_VERSION;
  const harnesses = requirements.harnesses ?? TASK_AGENTS;
  const steps: SshProvisionStep[] = [];

  if (!versionAtLeast(probe.nodeVersion, minimumNode)) {
    steps.push({
      kind: "runtime",
      reason: probe.nodeVersion ? "outdated" : "missing",
      presentVersion: probe.nodeVersion,
    });
  }

  if (!versionAtLeast(probe.agentVersion, requirements.expectedAgentVersion)) {
    steps.push({
      kind: "agent",
      reason: probe.agentVersion ? "outdated" : "missing",
      presentVersion: probe.agentVersion,
    });
  }

  for (const agent of harnesses) {
    // A harness the host already has is the user's, not Mission Control's to
    // replace or shadow. Updating an out-of-date one is a separate, explicit
    // action against that host's own installation.
    if (probe.harnessVersions[agent]) continue;
    steps.push({ kind: "harness", agent });
  }

  return {
    ok: true,
    platform: probe.platform,
    arch: probe.arch,
    prefix: sshPrefixPath(probe.homeDir),
    steps,
  };
}
