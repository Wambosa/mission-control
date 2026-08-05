import { describe, expect, it, vi } from "vitest";
import {
  allocateLoopbackPort,
  classifySshFailure,
  isFailFastSshFailure,
  openSshTunnel,
  sshTunnelArgs,
  type SshFailure,
  type SshProcessLike,
} from "../ssh-transport";

const noopExit = { onExit: () => {} };

/** A stand-in for the `ssh` process, so no test needs a real SSH server. */
function fakeSsh() {
  const listeners = { exit: [] as ((code: number | null) => void)[], error: [] as ((err: Error) => void)[] };
  const stderrListeners: ((chunk: unknown) => void)[] = [];
  const kill = vi.fn();
  const child: SshProcessLike = {
    stderr: { on: (_event, cb) => void stderrListeners.push(cb) },
    on: ((event: "exit" | "error", cb: never) => {
      listeners[event].push(cb);
    }) as SshProcessLike["on"],
    kill,
  };
  return {
    child,
    kill,
    emitStderr: (text: string) => stderrListeners.forEach((cb) => cb(text)),
    exit: (code: number | null) => listeners.exit.forEach((cb) => cb(code)),
    fail: (err: Error) => listeners.error.forEach((cb) => cb(err)),
  };
}

describe("sshTunnelArgs", () => {
  it("forwards a loopback port to the host's loopback runtime port", () => {
    const args = sshTunnelArgs({ alias: "workshop", remotePort: 9333 }, 54321);
    expect(args).toContain("-L");
    expect(args[args.indexOf("-L") + 1]).toBe("127.0.0.1:54321:127.0.0.1:9333");
    expect(args.at(-1)).toBe("workshop");
  });

  it("never passes a flag that would accept an unknown host key", () => {
    const args = sshTunnelArgs({ alias: "workshop", remotePort: 9333 }, 54321).join(" ");
    expect(args).not.toMatch(/StrictHostKeyChecking/i);
    expect(args).not.toMatch(/UserKnownHostsFile/i);
    expect(args).not.toMatch(/CheckHostIP=no/i);
    // With no terminal to prompt in, ssh must refuse rather than hang.
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ExitOnForwardFailure=yes");
  });
});

describe("classifySshFailure", () => {
  it("surfaces a host key refusal as SSH's, with no offer to bypass it", () => {
    const failure = classifySshFailure(
      "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.\n",
      255,
    );
    expect(failure.kind).toBe("host-key");
    expect(failure.message).toMatch(/will not accept a host key on your behalf/i);
    expect(failure.message).not.toMatch(/StrictHostKeyChecking|accept anyway|continue/i);
  });

  it("tells an authentication failure apart from an unreachable network", () => {
    const auth = classifySshFailure("sam@workshop: Permission denied (publickey).\n", 255);
    const network = classifySshFailure("ssh: Could not resolve hostname workshop\n", 255);
    expect(auth.kind).toBe("auth");
    expect(network.kind).toBe("network");
    expect(auth.message).not.toBe(network.message);
    expect(auth.message).toMatch(/key or agent/i);
    expect(network.message).toMatch(/could not reach/i);
  });

  it("reports a forward that could not be opened", () => {
    expect(
      classifySshFailure("bind: Address already in use\nchannel_setup_fwd_listener\n", 255).kind,
    ).toBe("forward");
  });

  it("ignores ssh's debug chatter when picking the reason", () => {
    const failure = classifySshFailure(
      "debug1: Reading configuration data /etc/ssh/ssh_config\nWarning: Permanently added 'workshop' to the list of known hosts.\nssh: connect to host workshop port 22: Connection refused\n",
      255,
    );
    expect(failure.kind).toBe("network");
    expect(failure.message).toContain("connect to host workshop port 22: Connection refused");
    expect(failure.message).not.toContain("debug1");
  });

  it("falls back to the exit code when ssh said nothing useful", () => {
    const failure = classifySshFailure("", 42);
    expect(failure.kind).toBe("unknown");
    expect(failure.message).toContain("42");
  });

  it("only gives up on failures another attempt cannot fix", () => {
    expect(isFailFastSshFailure("host-key")).toBe(true);
    expect(isFailFastSshFailure("auth")).toBe(true);
    expect(isFailFastSshFailure("client")).toBe(true);
    expect(isFailFastSshFailure("network")).toBe(false);
    expect(isFailFastSshFailure("forward")).toBe(false);
    expect(isFailFastSshFailure("unknown")).toBe(false);
  });
});

describe("openSshTunnel", () => {
  it("hands back a loopback agent URL on the port it reserved", async () => {
    const ssh = fakeSsh();
    const result = await openSshTunnel({ alias: "workshop", remotePort: 9333 }, noopExit, {
      spawnSsh: () => ssh.child,
      allocatePort: async () => 54321,
    });
    expect(result.ok && result.tunnel.agentUrl).toBe("ws://127.0.0.1:54321/");
    expect(result.ok && result.tunnel.localPort).toBe(54321);
    // Release the reservation so a later test can claim the same port.
    if (result.ok) result.tunnel.close();
  });

  it("gives two hosts distinct local ports while both forwards are live", async () => {
    const first = await openSshTunnel({ alias: "workshop", remotePort: 9333 }, noopExit, {
      spawnSsh: () => fakeSsh().child,
    });
    const second = await openSshTunnel({ alias: "attic", remotePort: 9333 }, noopExit, {
      spawnSsh: () => fakeSsh().child,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.tunnel.localPort).not.toBe(second.tunnel.localPort);
    first.tunnel.close();
    second.tunnel.close();
  });

  it("kills ssh when the tunnel is closed and reports nothing back", async () => {
    const ssh = fakeSsh();
    const onExit = vi.fn();
    const result = await openSshTunnel({ alias: "workshop", remotePort: 9333 }, { onExit }, {
      spawnSsh: () => ssh.child,
      allocatePort: async () => 54321,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.tunnel.close();
    expect(ssh.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.tunnel.isClosed).toBe(true);

    // The kill arrives as an exit; a teardown we asked for is not a failure.
    ssh.exit(null);
    expect(onExit).toHaveBeenCalledWith(null);
  });

  it("reports the classified refusal when ssh dies on its own", async () => {
    const ssh = fakeSsh();
    const failures: (SshFailure | null)[] = [];
    const result = await openSshTunnel(
      { alias: "workshop", remotePort: 9333 },
      { onExit: (failure) => void failures.push(failure) },
      { spawnSsh: () => ssh.child, allocatePort: async () => 54321 },
    );
    expect(result.ok).toBe(true);

    ssh.emitStderr("Host key verification failed.\n");
    ssh.exit(255);
    expect(failures[0]?.kind).toBe("host-key");
    expect(result.ok && result.tunnel.isClosed).toBe(true);
  });

  it("reports a missing ssh client as a failure retrying cannot fix", async () => {
    const ssh = fakeSsh();
    const failures: (SshFailure | null)[] = [];
    await openSshTunnel(
      { alias: "workshop", remotePort: 9333 },
      { onExit: (failure) => void failures.push(failure) },
      { spawnSsh: () => ssh.child, allocatePort: async () => 54321 },
    );
    ssh.fail(new Error("spawn ssh ENOENT"));
    expect(failures[0]?.kind).toBe("client");
    expect(isFailFastSshFailure(failures[0]!.kind)).toBe(true);
  });

  it("fails without spawning when no local port can be reserved", async () => {
    const spawnSsh = vi.fn();
    const result = await openSshTunnel({ alias: "workshop", remotePort: 9333 }, noopExit, {
      spawnSsh,
      allocatePort: async () => {
        throw new Error("no ports");
      },
    });
    expect(result.ok).toBe(false);
    expect(spawnSsh).not.toHaveBeenCalled();
  });
});

describe("allocateLoopbackPort", () => {
  it("returns a usable loopback port", async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });
});

describe("port reservation", () => {
  it("hands the next host a different port when the OS offers the same one twice", async () => {
    const offered = [54_321, 54_321, 54_322];
    const allocatePort = async () => offered.shift() ?? 0;
    const first = await openSshTunnel({ alias: "workshop", remotePort: 9333 }, noopExit, {
      spawnSsh: () => fakeSsh().child,
      allocatePort,
    });
    const second = await openSshTunnel({ alias: "attic", remotePort: 9333 }, noopExit, {
      spawnSsh: () => fakeSsh().child,
      allocatePort,
    });

    expect(first.ok && first.tunnel.localPort).toBe(54_321);
    expect(second.ok && second.tunnel.localPort).toBe(54_322);

    if (first.ok) first.tunnel.close();
    if (second.ok) second.tunnel.close();
  });

  it("frees the port again once the forward closes", async () => {
    const open = () =>
      openSshTunnel({ alias: "workshop", remotePort: 9333 }, noopExit, {
        spawnSsh: () => fakeSsh().child,
        allocatePort: async () => 54_323,
      });

    const first = await open();
    if (first.ok) first.tunnel.close();
    const second = await open();

    expect(second.ok && second.tunnel.localPort).toBe(54_323);
    if (second.ok) second.tunnel.close();
  });
});
