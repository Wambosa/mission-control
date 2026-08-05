import { spawn as nodeSpawn } from "node:child_process";
import * as net from "node:net";
import { normalizeRemoteAgentUrl } from "../src/shared/sandbox";

// The SSH hop. Mission Control shells out to the user's own `ssh` so their
// config, agent, and known_hosts apply exactly as they do in a terminal — the
// whole point of defining hosts in the SSH config. The tunnel forwards a
// loopback port on this machine to the runtime's loopback port on the host, so
// the runtime never listens on a network interface and nothing here needs a
// certificate, an inbound firewall rule, or a pasted key.

export type SshFailureKind =
  | "host-key"
  | "auth"
  | "network"
  | "forward"
  | "client"
  | "unknown";

export type SshFailure = { kind: SshFailureKind; message: string };

/**
 * Whether retrying is pointless. A rejected host key or a failed login will be
 * rejected again a second later, and both need the user, not another attempt.
 * Everything else — an unreachable network, a port that raced — gets the
 * sandbox lifecycle's existing backoff.
 */
export function isFailFastSshFailure(kind: SshFailureKind): boolean {
  return kind === "host-key" || kind === "auth" || kind === "client";
}

export type SshTunnelHandle = {
  /** Loopback URL the agent WebSocket connects to. */
  readonly agentUrl: string;
  readonly localPort: number;
  /** True once `ssh` has exited or the tunnel has been closed. */
  readonly isClosed: boolean;
  close: () => void;
};

export type SshTunnelResult =
  | { ok: true; tunnel: SshTunnelHandle }
  | { ok: false; error: string };

export type SshProcessLike = {
  stderr: { on: (event: "data", cb: (chunk: unknown) => void) => void } | null;
  on: {
    (event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    (event: "error", cb: (err: Error) => void): unknown;
  };
  kill: (signal?: NodeJS.Signals) => void;
};

export type SshTunnelDeps = {
  /** Injected so tests can drive `ssh` without a server. */
  spawnSsh?: (args: string[]) => SshProcessLike;
  /** Injected so tests get deterministic ports. */
  allocatePort?: () => Promise<number>;
};

export type SshTunnelOptions = {
  /** Host alias exactly as the user's SSH config spells it. */
  alias: string;
  /** Port the runtime listens on, on the far side. Loopback there too. */
  remotePort: number;
};

export type SshTunnelCallbacks = {
  /** `ssh` exited. `failure` is null for an exit we asked for. */
  onExit: (failure: SshFailure | null) => void;
};

const LOOPBACK = "127.0.0.1";

/**
 * Options every `ssh` invocation shares. Notably absent: anything that would
 * accept an unknown or changed host key. Trust decisions stay with the user's
 * SSH setup, which is the whole reason hosts are defined there.
 */
export const SSH_COMMON_OPTIONS: readonly string[] = [
  // Never prompt — Electron has no terminal to prompt in, so ssh must refuse.
  "-o",
  "BatchMode=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
];

/** Flags that make `ssh` a transport rather than a terminal session. */
export function sshTunnelArgs(options: SshTunnelOptions, localPort: number): string[] {
  return [
    "-N", // no remote command; this connection exists for the forward
    "-T", // no pty
    ...SSH_COMMON_OPTIONS,
    // A tunnel that silently forwards nothing is worse than no tunnel.
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `${LOOPBACK}:${localPort}:${LOOPBACK}:${options.remotePort}`,
    options.alias,
  ];
}

function firstMeaningfulLine(stderr: string): string {
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    // OpenSSH prefixes progress chatter with these; they are never the reason.
    if (!trimmed || /^(debug\d*|Warning: Permanently added)/i.test(trimmed)) continue;
    return trimmed;
  }
  return "";
}

/**
 * Turn an `ssh` exit into something the user can act on. Host-key trouble is
 * called out as SSH's refusal, not Mission Control's, and never comes with an
 * offer to bypass it.
 */
export function classifySshFailure(stderr: string, exitCode: number | null): SshFailure {
  const detail = firstMeaningfulLine(stderr);
  const haystack = stderr.toLowerCase();

  if (
    /host key verification failed|remote host identification has changed|no matching host key|host key for .* has changed/.test(
      haystack,
    )
  ) {
    return {
      kind: "host-key",
      message: `SSH refused this host: ${detail || "host key verification failed"}. Resolve it with ssh yourself — Mission Control will not accept a host key on your behalf.`,
    };
  }
  if (
    /permission denied|too many authentication failures|no supported authentication methods|authentication failed|host key verification|publickey\)/.test(
      haystack,
    )
  ) {
    return {
      kind: "auth",
      message: `SSH could not authenticate to this host: ${detail || "permission denied"}. Check the key or agent your SSH config uses for it.`,
    };
  }
  if (
    /could not resolve hostname|name or service not known|nodename nor servname|connection timed out|connection refused|network is unreachable|no route to host|operation timed out/.test(
      haystack,
    )
  ) {
    return {
      kind: "network",
      message: `Could not reach this host over SSH: ${detail || "the host is unreachable"}.`,
    };
  }
  if (/bind: address already in use|cannot listen to port|channel \d+: open failed/.test(haystack)) {
    return {
      kind: "forward",
      message: `SSH connected but could not open the port forward: ${detail || "the local port is in use"}.`,
    };
  }
  return {
    kind: "unknown",
    message: detail
      ? `SSH connection failed: ${detail}`
      : `SSH exited with code ${exitCode ?? "unknown"}.`,
  };
}

// Ports held by a live tunnel. The OS will happily offer the same free port to
// two probes in a row, so two hosts connecting at once need this to keep their
// forwards apart.
const portsInUse = new Set<number>();

/** Ask the OS for a port nothing is listening on right now. */
export function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, LOOPBACK, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free loopback port"))));
    });
  });
}

/**
 * Claim a port no live tunnel holds. The check and the claim sit together with
 * no await between them, so a second host opening concurrently cannot slip in
 * and take the same one.
 */
async function reserveLoopbackPort(allocate: () => Promise<number>): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await allocate();
    if (!portsInUse.has(port)) {
      portsInUse.add(port);
      return port;
    }
  }
  throw new Error("could not find a free loopback port for the SSH forward");
}

function toText(chunk: unknown): string {
  return typeof chunk === "string" ? chunk : String(chunk);
}

function tunnelKill(child: SshProcessLike): void {
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

/**
 * Open the forward for one host. Resolves as soon as `ssh` is running: whether
 * the runtime on the far side answers is the agent connection's question, and
 * the sandbox lifecycle already retries that with backoff. An `ssh` that dies
 * — immediately or hours later — arrives through `onExit`.
 */
export async function openSshTunnel(
  options: SshTunnelOptions,
  callbacks: SshTunnelCallbacks,
  deps: SshTunnelDeps = {},
): Promise<SshTunnelResult> {
  let localPort: number;
  try {
    localPort = await reserveLoopbackPort(deps.allocatePort ?? allocateLoopbackPort);
  } catch (err) {
    return { ok: false, error: `Could not reserve a local port for the SSH forward: ${String(err)}` };
  }

  const args = sshTunnelArgs(options, localPort);
  const spawnSsh =
    deps.spawnSsh ?? ((argv: string[]) => nodeSpawn("ssh", argv, { stdio: ["ignore", "ignore", "pipe"] }) as unknown as SshProcessLike);

  let child: SshProcessLike;
  try {
    child = spawnSsh(args);
  } catch (err) {
    portsInUse.delete(localPort);
    return { ok: false, error: `Could not start ssh: ${String(err)}` };
  }

  let stderr = "";
  let closed = false;
  let requested = false;

  const release = (): void => {
    if (closed) return;
    closed = true;
    portsInUse.delete(localPort);
  };

  child.stderr?.on("data", (chunk) => {
    // Bounded: a wedged connection can chatter, and only the first lines matter.
    if (stderr.length < 8_192) stderr += toText(chunk);
  });

  child.on("exit", (code) => {
    release();
    // We asked for this one; there is nothing to report.
    callbacks.onExit(requested ? null : classifySshFailure(stderr, code));
  });

  child.on("error", (err) => {
    release();
    if (requested) return callbacks.onExit(null);
    callbacks.onExit({ kind: "client", message: `Could not start ssh: ${err.message}` });
  });

  const agentUrl = normalizeRemoteAgentUrl(`ws://${LOOPBACK}:${localPort}`);
  if (!agentUrl) {
    tunnelKill(child);
    release();
    return { ok: false, error: "Could not build a loopback URL for the SSH forward." };
  }

  const tunnel: SshTunnelHandle = {
    agentUrl,
    localPort,
    get isClosed() {
      return closed;
    },
    close: () => {
      requested = true;
      release();
      tunnelKill(child);
    },
  };
  return { ok: true, tunnel };
}
