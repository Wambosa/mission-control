import { REMOTE_AGENT_COMMAND, shellQuote, type SshHostPlatform } from "./ssh-provision";

// The runtime on a host belongs to the SSH user's own service manager, not to
// the client that provisioned it — that is what lets sessions outlive Mission
// Control quitting and the host rebooting. macOS gets a LaunchAgent, Linux a
// `systemd --user` unit, both rendered from one description so the two cannot
// drift apart.
//
// Rendering is pure and deterministic: same host in, same bytes out. Writing
// the files and registering them is the SSH half, in electron/.

/** Reverse-DNS label the LaunchAgent registers under. */
export const SSH_SERVICE_LABEL = "com.mission-control.agent";

/** Unit name the systemd user manager registers under. */
export const SSH_SERVICE_UNIT_NAME = "mission-control-agent.service";

/** Loopback port the runtime listens on, on the host. */
export const DEFAULT_SSH_AGENT_PORT = 9333;

/** The runtime never listens anywhere else; the SSH forward is the only way in. */
const LOOPBACK = "127.0.0.1";

export type SshServiceDescription = {
  platform: SshHostPlatform;
  /** The SSH user's home directory, as the host reports it. */
  homeDir: string;
  /** Directory Mission Control owns on the host. */
  prefix: string;
  agentPort: number;
  /** Bearer secret Mission Control generated for this host. Never the user's. */
  apiKey: string;
  /** Agent version being registered, recorded in the runtime manifest. */
  agentVersion: string;
  /**
   * Directory on the host the runtime treats as the root it may work in.
   * Null means the SSH user's own home, which is the right default but not
   * always the right answer: a host may keep its projects on another volume,
   * and confining the runtime to `$HOME` puts those out of reach.
   */
  workspaceRoot?: string | null;
};

export type SshServiceFile = {
  path: string;
  /** Octal mode, as `chmod` takes it. */
  mode: string;
  contents: string;
};

export type SshServiceDefinition = {
  /** Env file, runner, and the platform unit — in the order they are written. */
  files: SshServiceFile[];
  /** Which of `files` the platform's service manager loads. */
  unitPath: string;
};

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/**
 * What the service runs with. The prefix binary directory comes first, which
 * is what makes a harness Mission Control installed selectable for sessions on
 * this host without touching the user's own shell configuration.
 */
export function sshServicePath(description: SshServiceDescription): string {
  const prefix = trimTrailingSlash(description.prefix);
  return [`${prefix}/bin`, `${prefix}/runtime/bin`, "/usr/local/bin", "/usr/bin", "/bin"].join(":");
}

/**
 * The directory the runtime is confined to. Falls back to the SSH user's home,
 * which is what every host recorded before this was configurable used.
 */
export function sshWorkspaceRoot(
  description: Pick<SshServiceDescription, "homeDir" | "workspaceRoot">,
): string {
  const configured = description.workspaceRoot?.trim();
  return configured ? trimTrailingSlash(configured) : trimTrailingSlash(description.homeDir);
}

/** Non-secret settings both platforms declare on the unit itself. */
function serviceEnvironment(description: SshServiceDescription): Array<[string, string]> {
  return [
    ["HOME", description.homeDir],
    ["PATH", sshServicePath(description)],
    ["MC_AGENT_BIND_HOST", LOOPBACK],
    ["MC_AGENT_PORT", String(description.agentPort)],
    // The user owns this machine, so their own home is the confinement root —
    // a project on an SSH host lives where they already keep it. A host that
    // keeps its work somewhere else (another volume, a shared checkout dir)
    // can name that instead.
    ["MC_WORKSPACE_ROOT", sshWorkspaceRoot(description)],
  ];
}

/**
 * What the runtime on a host is, in a form a later client can read without
 * knowing which service manager wrote it. Provisioning has always described
 * the runtime to the *host*; this describes it to the *next Mission Control*,
 * which is what makes adopting an existing runtime possible instead of
 * overwriting it. Deliberately holds no secret — the key stays in agent.env,
 * which is the only 600 file here.
 */
export type SshRuntimeManifest = {
  agentPort: number;
  agentVersion: string;
};

export function renderSshRuntimeManifest(manifest: SshRuntimeManifest): string {
  return `${JSON.stringify(manifest, null, 2)}
`;
}

export function parseSshRuntimeManifest(text: string): SshRuntimeManifest | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const agentPort = typeof record.agentPort === "number" ? record.agentPort : NaN;
    if (!Number.isInteger(agentPort) || agentPort <= 0 || agentPort > 65535) return null;
    return {
      agentPort,
      agentVersion: typeof record.agentVersion === "string" ? record.agentVersion : "",
    };
  } catch {
    return null;
  }
}

function servicePaths(description: SshServiceDescription): {
  envFile: string;
  runner: string;
  logFile: string;
  manifest: string;
} {
  const prefix = trimTrailingSlash(description.prefix);
  return {
    envFile: `${prefix}/service/agent.env`,
    runner: `${prefix}/service/run-agent.sh`,
    logFile: `${prefix}/log/agent.log`,
    manifest: `${prefix}/service/runtime.json`,
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The only file holding the host's bearer secret, so it is the only one that
 * needs a restrictive mode. launchd has no equivalent of systemd's
 * `EnvironmentFile`, so both platforms reach it the same way: through the
 * runner below.
 */
function renderEnvFile(description: SshServiceDescription): string {
  return `MC_AGENT_API_KEY=${description.apiKey}\n`;
}

function renderRunner(description: SshServiceDescription): string {
  const { envFile } = servicePaths(description);
  const prefix = trimTrailingSlash(description.prefix);
  return [
    "#!/bin/sh",
    "set -eu",
    `if [ -f ${shellQuote(envFile)} ]; then`,
    "  set -a",
    `  . ${shellQuote(envFile)}`,
    "  set +a",
    "fi",
    `exec ${shellQuote(`${prefix}/bin/${REMOTE_AGENT_COMMAND}`)}`,
    "",
  ].join("\n");
}

function renderLaunchAgent(description: SshServiceDescription): string {
  const { runner, logFile } = servicePaths(description);
  const environment = serviceEnvironment(description)
    .map(([key, value]) => `    <key>${key}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${SSH_SERVICE_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>/bin/sh</string>`,
    `    <string>${xmlEscape(runner)}</string>`,
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    environment,
    `  </dict>`,
    // Together these are "run it now and keep it running" — the host reboots
    // and the runtime comes back without Mission Control being there.
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${xmlEscape(description.homeDir)}</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xmlEscape(logFile)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xmlEscape(logFile)}</string>`,
    `</dict>`,
    `</plist>`,
    "",
  ].join("\n");
}

function renderSystemdUnit(description: SshServiceDescription): string {
  const { runner } = servicePaths(description);
  const environment = serviceEnvironment(description)
    .map(([key, value]) => `Environment=${key}=${value}`)
    .join("\n");
  return [
    `[Unit]`,
    `Description=Mission Control Agent`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `WorkingDirectory=${description.homeDir}`,
    environment,
    `ExecStart=/bin/sh ${runner}`,
    `Restart=always`,
    `RestartSec=3`,
    ``,
    // A user unit belongs to the user's own default target. `multi-user.target`
    // is the system manager's, which would need the root this design refuses.
    `[Install]`,
    `WantedBy=default.target`,
    "",
  ].join("\n");
}

/**
 * Where the platform's service manager expects to find the unit. Takes only
 * the platform and home so removal, which has no key or port to hand, can ask
 * the same question provisioning did.
 */
export function sshServiceUnitPath(
  description: Pick<SshServiceDescription, "platform" | "homeDir">,
): string {
  const home = trimTrailingSlash(description.homeDir);
  return description.platform === "darwin"
    ? `${home}/Library/LaunchAgents/${SSH_SERVICE_LABEL}.plist`
    : `${home}/.config/systemd/user/${SSH_SERVICE_UNIT_NAME}`;
}

/** What a host reported about a runtime it already has. */
export type SshExistingRuntime = {
  /** The key the running service is already using. Adopted, never rotated. */
  apiKey: string;
  /** Null when the runtime predates the manifest; the caller then falls back. */
  manifest: SshRuntimeManifest | null;
};

/**
 * Ask a host what runtime it already has. This is the read that provisioning
 * never did — without it, a second Mission Control writes a fresh key over the
 * one the first is still holding, and the first starts getting 401s it has no
 * way to explain.
 *
 * The reply carries the host's bearer secret, so its stdout is the one place
 * in this module that must never reach a log or a progress event.
 */
export function sshRuntimeReadScript(
  description: Pick<SshServiceDescription, "platform" | "homeDir" | "prefix">,
): string {
  const prefix = trimTrailingSlash(description.prefix);
  const envFile = shellQuote(`${prefix}/service/agent.env`);
  const manifestFile = shellQuote(`${prefix}/service/runtime.json`);
  const unitPath = shellQuote(sshServiceUnitPath(description));
  return [
    "set -u",
    // A key with no unit is a leftover, not a runtime: treat it as absent so
    // the caller provisions cleanly rather than adopting something dead.
    `if [ -f ${envFile} ] && [ -f ${unitPath} ]; then`,
    `  printf 'present=1\\n'`,
    `  printf 'manifest=%s\\n' "$(tr -d '\\n' < ${manifestFile} 2>/dev/null || true)"`,
    `  printf 'key=%s\\n' "$(sed -n 's/^MC_AGENT_API_KEY=//p' ${envFile} 2>/dev/null | head -n 1)"`,
    "else",
    `  printf 'present=0\\n'`,
    "fi",
    "",
  ].join("\n");
}

/** Read {@link sshRuntimeReadScript}'s reply. Absent or keyless means no runtime. */
export function parseSshRuntimeRead(stdout: string): SshExistingRuntime | null {
  const fields = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1));
  }
  if (fields.get("present") !== "1") return null;
  const apiKey = (fields.get("key") ?? "").trim();
  if (!apiKey) return null;
  const rawManifest = (fields.get("manifest") ?? "").trim();
  return { apiKey, manifest: rawManifest ? parseSshRuntimeManifest(rawManifest) : null };
}

/**
 * Everything one host needs written, in write order. The unit lands where the
 * service manager looks — the one thing this design places outside the prefix,
 * because a unit the manager cannot see is not a registered service. Host
 * removal deletes it by this same path.
 */
export function sshServiceDefinition(description: SshServiceDescription): SshServiceDefinition {
  const { envFile, runner, manifest } = servicePaths(description);
  const unitPath = sshServiceUnitPath(description);
  return {
    files: [
      { path: envFile, mode: "600", contents: renderEnvFile(description) },
      { path: runner, mode: "700", contents: renderRunner(description) },
      // Readable: it is how the next client learns which port this runtime
      // took, without having to parse a systemd unit or a plist.
      {
        path: manifest,
        mode: "644",
        contents: renderSshRuntimeManifest({
          agentPort: description.agentPort,
          agentVersion: description.agentVersion,
        }),
      },
      {
        path: unitPath,
        mode: "600",
        contents:
          description.platform === "darwin"
            ? renderLaunchAgent(description)
            : renderSystemdUnit(description),
      },
    ],
    unitPath,
  };
}
