import { randomBytes } from "node:crypto";
import {
  SSH_SERVICE_LABEL,
  SSH_SERVICE_UNIT_NAME,
  sshServiceDefinition,
  type SshServiceDescription,
  type SshServiceFile,
} from "../src/shared/ssh-service-unit";
import { defaultSshExec, shellQuote, sshShellArgs, type SshExec } from "./ssh-exec";
import { classifySshFailure } from "./ssh-transport";

// Writing the rendered service onto a host and handing it to the user's own
// service manager. Everything here runs as the SSH user: `systemctl --user`
// and `launchctl` in the user's own domain, never the system's.

/** How well the runtime survives the user logging out. */
export type SshServiceLingering =
  /** Linux, lingering on: the runtime survives logout and reboot. */
  | "enabled"
  /** Linux, lingering refused: the runtime may stop when the user logs out. */
  | "unavailable"
  /** macOS, where a LaunchAgent needs no equivalent. */
  | "not-applicable";

export type SshServiceInstallResult =
  | { ok: true; lingering: SshServiceLingering; unitPath: string }
  | { ok: false; error: string };

/** Marker the install script prints so lingering can be read back. */
const LINGER_MARKER = "mc:linger=";

/**
 * The bearer secret for one host's runtime. Mission Control generates it and
 * keeps it — R5's promise is that the user never pastes an API key, not that
 * there isn't one.
 */
export function generateSshApiKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * A heredoc with a quoted delimiter, so nothing in a rendered unit is expanded
 * by the shell on the way in.
 */
function writeFileFragment(file: SshServiceFile, index: number): string {
  const delimiter = `MC_FILE_${index}`;
  return [
    `mkdir -p "$(dirname ${shellQuote(file.path)})"`,
    `cat > ${shellQuote(file.path)} <<'${delimiter}'`,
    file.contents.replace(/\n$/, ""),
    delimiter,
    `chmod ${file.mode} ${shellQuote(file.path)}`,
  ].join("\n");
}

/**
 * Reload and start the LaunchAgent. `bootstrap` is the modern spelling and
 * `load` the one older macOS understands, so try both before giving up.
 */
function launchdFragment(unitPath: string): string {
  const target = `gui/$(id -u)`;
  const service = `${target}/${SSH_SERVICE_LABEL}`;
  return [
    // Booting out an agent that isn't loaded is not an error worth failing on.
    `launchctl bootout ${service} >/dev/null 2>&1 || true`,
    `if ! launchctl bootstrap ${target} ${shellQuote(unitPath)} >/dev/null 2>&1; then`,
    `  launchctl load -w ${shellQuote(unitPath)}`,
    `fi`,
    `launchctl kickstart -k ${service} >/dev/null 2>&1 || true`,
  ].join("\n");
}

/**
 * Hand the unit to the user's systemd. Lingering is what keeps a user manager
 * alive after logout; some distributions refuse it, and a host that refuses is
 * still a host worth using — it just stops the runtime when the user logs out.
 */
function systemdFragment(): string {
  return [
    `systemctl --user daemon-reload`,
    `systemctl --user enable --now ${SSH_SERVICE_UNIT_NAME}`,
    `if loginctl enable-linger "$(id -un)" >/dev/null 2>&1; then`,
    `  echo "${LINGER_MARKER}enabled"`,
    `else`,
    `  echo "${LINGER_MARKER}unavailable"`,
    `fi`,
  ].join("\n");
}

/** Write the service onto a host and register it, as one script. */
export function sshServiceInstallScript(description: SshServiceDescription): string {
  const definition = sshServiceDefinition(description);
  return [
    "set -eu",
    ...definition.files.map(writeFileFragment),
    description.platform === "darwin"
      ? launchdFragment(definition.unitPath)
      : systemdFragment(),
    "",
  ].join("\n");
}

function readLingering(
  description: SshServiceDescription,
  stdout: string,
): SshServiceLingering {
  if (description.platform === "darwin") return "not-applicable";
  return stdout.includes(`${LINGER_MARKER}enabled`) ? "enabled" : "unavailable";
}

function installFailure(stderr: string, code: number | null): string {
  if (code === 255 || code === null) return classifySshFailure(stderr, code).message;
  const detail = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return detail
    ? `Could not register the Mission Control service on this host: ${detail}`
    : `Could not register the Mission Control service on this host (exit ${code}).`;
}

/**
 * Register the runtime with the host user's service manager. One SSH exec:
 * the files and the registration travel together, so a host is never left with
 * a written unit nobody loaded.
 */
export async function installSshService(
  alias: string,
  description: SshServiceDescription,
  exec: SshExec = defaultSshExec,
): Promise<SshServiceInstallResult> {
  const definition = sshServiceDefinition(description);
  const result = await exec(sshShellArgs(alias), sshServiceInstallScript(description));
  if (result.code !== 0) {
    return { ok: false, error: installFailure(result.stderr, result.code) };
  }
  return {
    ok: true,
    lingering: readLingering(description, result.stdout),
    unitPath: definition.unitPath,
  };
}
