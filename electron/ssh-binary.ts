import * as fs from "node:fs";
import * as path from "node:path";

// Which `ssh` Mission Control runs.
//
// Spawning bare "ssh" hands the decision to PATH order, and on Windows that is
// not the same ssh the user's other tools run. A machine with Git for Windows
// installed usually has Git's MSYS ssh ahead of the system one, and the two
// differ in ways that decide whether a connection works at all:
//
//   - They disagree about key files. An OpenSSH-format key saved with CRLF
//     line endings loads under Windows' older build and is refused by Git's
//     newer one with "error in libcrypto" — same key, same config, same host.
//   - They cannot share an agent. Windows' ssh talks to the OpenSSH
//     Authentication Agent service over a named pipe; Git's MSYS build cannot
//     reach it. Since the transport runs with BatchMode=yes and can never
//     prompt, an agent that ssh cannot see means no authentication at all.
//
// So the binary is chosen deliberately: the system one, which is what the rest
// of the user's tooling uses, with an override for anyone who wants a
// different build. On POSIX there is one ssh and PATH is the right answer.

/** Where Windows keeps the OpenSSH client it ships. */
function systemSshPath(env: NodeJS.ProcessEnv): string | null {
  const root = env.SystemRoot?.trim() || env.windir?.trim();
  if (!root) return null;
  return path.join(root, "System32", "OpenSSH", "ssh.exe");
}

export type SshBinaryChoice = {
  /** What to spawn. A bare name means "let PATH decide". */
  command: string;
  /** Why this one, for the message a failure carries. */
  source: "override" | "system" | "path";
};

export type ResolveSshBinaryInput = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Injected so the choice is testable without a filesystem. */
  exists: (candidate: string) => boolean;
  /** The user's explicit choice, when they made one. */
  override?: string | null;
};

/**
 * Decide once which ssh to run. An override always wins, even if it does not
 * exist — a user who names a binary should be told it is missing rather than
 * quietly given a different one.
 */
export function resolveSshBinary(input: ResolveSshBinaryInput): SshBinaryChoice {
  // A stored preference first, then the environment — the env var is the
  // escape hatch that needs no settings screen to reach.
  const override = input.override?.trim() || input.env.MC_SSH_PATH?.trim();
  if (override) return { command: override, source: "override" };

  if (input.platform === "win32") {
    const system = systemSshPath(input.env);
    if (system && input.exists(system)) return { command: system, source: "system" };
  }
  return { command: "ssh", source: "path" };
}

let cached: SshBinaryChoice | null = null;
let configuredOverride: string | null = null;

/**
 * Record the user's chosen ssh, before anything spawns one. Clears the cached
 * choice so a change takes effect without a restart.
 */
export function configureSshBinary(override: string | null | undefined): void {
  configuredOverride = override?.trim() || null;
  cached = null;
}

/** The ssh this process runs, resolved once. */
export function sshBinaryChoice(): SshBinaryChoice {
  cached ??= resolveSshBinary({
    platform: process.platform,
    env: process.env,
    exists: (candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
    override: configuredOverride,
  });
  return cached;
}

/** The executable to spawn. */
export function sshBinary(): string {
  return sshBinaryChoice().command;
}

/**
 * How to name the ssh in a failure. A message that says only "error in
 * libcrypto" sends the user looking at their key; naming the binary that said
 * it is usually the whole diagnosis, because their other tools run a different
 * one.
 */
export function describeSshBinary(choice: SshBinaryChoice = sshBinaryChoice()): string {
  return choice.source === "path" ? "ssh (from PATH)" : choice.command;
}
