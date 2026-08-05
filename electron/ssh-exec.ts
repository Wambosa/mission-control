import { spawn as nodeSpawn } from "node:child_process";
import { SSH_COMMON_OPTIONS } from "./ssh-transport";

// One-shot commands over SSH. The probe reads, provisioning writes, and both
// want the same thing: a POSIX shell on the far side fed a script it never has
// to quote. Injected everywhere so no test needs a host.

export type SshExecResult = { code: number | null; stdout: string; stderr: string };

/** Run a shell script on a host over SSH. Injected for tests. */
export type SshExec = (args: string[], stdin: string) => Promise<SshExecResult>;

/**
 * `sh -s` reads the script from stdin, which keeps it out of the command line
 * entirely — no quoting to get wrong, nothing in the host's process list. As
 * with the tunnel, no flag here relaxes host-key checking.
 */
export function sshShellArgs(alias: string): string[] {
  return ["-T", ...SSH_COMMON_OPTIONS, alias, "sh", "-s"];
}

export const defaultSshExec: SshExec = (args, stdin) =>
  new Promise((resolve) => {
    const child = nodeSpawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => resolve({ code: null, stdout, stderr: `${stderr}${err.message}` }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });

/**
 * POSIX single-quoting. Every host path Mission Control interpolates into a
 * script goes through here, because a home directory is the user's to name.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
