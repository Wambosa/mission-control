import { describe, it, expect, vi } from "vitest";
import { SandboxInstance, SandboxRegistry, type RegistryDeps, type AgentCallbacks } from "../sandbox-registry";
import { EXPECTED_SANDBOX_AGENT_VERSION, type SandboxConfig, type SandboxState } from "../sandbox-types";
import type { SshFailure, SshTunnelCallbacks, SshTunnelResult } from "../ssh-transport";
import { DEFAULT_SSH_IDLE_WINDOW_MINUTES } from "../../src/shared/sandbox";

function config(id: string): SandboxConfig {
  return {
    id,
    kind: "remote-vm",
    imageTag: null,
    dockerfilePath: null,
    buildArgs: {},
    env: {},
    gitAuthMode: "none",
    copyAgentCreds: false,
    declaredPorts: [],
    hostAgentPort: null,
    portMap: null,
    remoteAgentUrl: "wss://agent.example.com/",
    pairingToken: "remote-token",
    remoteAgentCa: null,
    remoteStatus: null,
    remoteProvider: null,
    sshHost: null,
  };
}

function sshConfig(id: string, alias = "workshop"): SandboxConfig {
  return {
    ...config(id),
    kind: "ssh-host",
    // An SSH host has no persisted URL — the forward supplies one per attempt.
    remoteAgentUrl: null,
    sshHost: {
      alias,
      prefix: "/home/sam/.mission-control",
      onDisconnect: "persist",
      idleWindowMinutes: DEFAULT_SSH_IDLE_WINDOW_MINUTES,
    },
  };
}

/** One `ssh` forward the harness handed out, plus the levers to end it. */
type TunnelDouble = {
  alias: string | undefined;
  localPort: number;
  closed: boolean;
  /** Simulate `ssh` exiting on its own. */
  die: (failure: SshFailure) => void;
};

type Harness = {
  deps: RegistryDeps;
  states: (id: string) => string[];
  lastAgentCb: () => AgentCallbacks | null;
  lastAgentUrl: () => string | null;
  connectCount: () => number;
  setConnectBudgetMs: (ms: number) => void;
  tunnels: TunnelDouble[];
  failTunnelOpen: (error: string) => void;
};

function harness(): Harness {
  const emitted = new Map<string, string[]>();
  let agentCb: AgentCallbacks | null = null;
  let agentUrl: string | null = null;
  let connects = 0;
  let budgetMs = 180_000;
  let openError: string | null = null;
  let nextPort = 40_000;
  const tunnels: TunnelDouble[] = [];

  const openSshTunnel = (
    cfg: SandboxConfig,
    cb: SshTunnelCallbacks,
  ): Promise<SshTunnelResult> => {
    if (openError) return Promise.resolve({ ok: false, error: openError });
    const localPort = nextPort++;
    const entry: TunnelDouble = {
      alias: cfg.sshHost?.alias,
      localPort,
      closed: false,
      die: (failure) => {
        entry.closed = true;
        cb.onExit(failure);
      },
    };
    tunnels.push(entry);
    return Promise.resolve({
      ok: true,
      tunnel: {
        agentUrl: `ws://127.0.0.1:${localPort}/`,
        localPort,
        get isClosed() {
          return entry.closed;
        },
        close: () => {
          entry.closed = true;
        },
      },
    });
  };

  const deps: RegistryDeps = {
    connectAgent: (_c, url, _t, cb) => {
      agentCb = cb;
      agentUrl = url;
      connects += 1;
      return { close: () => {} };
    },
    emitState: (id, state: SandboxState) => {
      const arr = emitted.get(id) ?? [];
      arr.push(state.status);
      emitted.set(id, arr);
    },
    connectBudgetMs: () => budgetMs,
    openSshTunnel,
  };

  return {
    deps,
    states: (id) => emitted.get(id) ?? [],
    lastAgentCb: () => agentCb,
    lastAgentUrl: () => agentUrl,
    connectCount: () => connects,
    setConnectBudgetMs: (ms) => (budgetMs = ms),
    tunnels,
    failTunnelOpen: (error) => (openError = error),
  };
}

/** Let the SSH connect path's awaits settle before asserting. */
const settle = (): Promise<void> => new Promise((resolve) => process.nextTick(resolve));

describe("SandboxInstance lifecycle", () => {
  it("starts → running → connected when the agent reports a current version", async () => {
    const h = harness();
    const inst = new SandboxInstance(config("sb-1"), h.deps);
    await inst.start();
    h.lastAgentCb()!.onReady(EXPECTED_SANDBOX_AGENT_VERSION, { claude: "2.1" });
    expect(h.states("sb-1")).toEqual(["starting", "running", "connected"]);
    expect(inst.state).toMatchObject({ status: "connected", version: EXPECTED_SANDBOX_AGENT_VERSION });
  });

  it("surfaces update-required on a version mismatch", async () => {
    const h = harness();
    const inst = new SandboxInstance(config("sb-1"), h.deps);
    await inst.start();
    h.lastAgentCb()!.onReady("0.0.1", {});
    expect(inst.state).toMatchObject({ status: "update-required", expectedVersion: EXPECTED_SANDBOX_AGENT_VERSION });
  });

  it("errors when the remote agent URL or API key is missing", async () => {
    const h = harness();
    const inst = new SandboxInstance({ ...config("sb-1"), remoteAgentUrl: null }, h.deps);
    const r = await inst.start();
    expect(r.ok).toBe(false);
    expect(inst.state.status).toBe("error");
    expect(h.connectCount()).toBe(0);
  });

  it("does not connect a paused remote VM sandbox", async () => {
    const h = harness();
    const paused = { ...config("sb-remote"), remoteStatus: "paused" };
    const inst = new SandboxInstance(paused, h.deps);

    const r = await inst.start();

    expect(r.ok).toBe(false);
    expect(inst.state).toMatchObject({ status: "stopped" });
    expect(h.connectCount()).toBe(0);
  });

  it("staleness guard: a dispose during start prevents a stale reconnect from connecting", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const inst = new SandboxInstance(config("sb-1"), h.deps);
      await inst.start();
      expect(h.connectCount()).toBe(1);

      // The first connect drops; a reconnect is scheduled.
      h.lastAgentCb()!.onClose();
      inst.dispose(); // bumps the op epoch + sets manualStop
      await vi.advanceTimersByTimeAsync(30_000);

      expect(h.connectCount()).toBe(1); // the stale reconnect never fired
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects with backoff when the first agent connect drops (agent not ready yet)", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const inst = new SandboxInstance(config("sb-1"), h.deps);
      await inst.start();
      expect(h.connectCount()).toBe(1);

      // First WS attempt fails before `ready` (the classic "socket hang up").
      h.lastAgentCb()!.onClose();
      expect(inst.state.status).toBe("running"); // not stuck dead — awaiting retry
      expect(h.connectCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000); // backoff fires → retry
      expect(h.connectCount()).toBe(2);

      // This time the agent comes up.
      h.lastAgentCb()!.onReady(EXPECTED_SANDBOX_AGENT_VERSION, {});
      expect(inst.state.status).toBe("connected");

      // A clean stop cancels any pending reconnect.
      await inst.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.connectCount()).toBe(2); // no further reconnect attempts
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the connect budget is exceeded", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.setConnectBudgetMs(5_000);
      const inst = new SandboxInstance(config("sb-remote"), h.deps);
      await inst.start();

      while (inst.state.status !== "error") {
        h.lastAgentCb()!.onClose();
        await vi.advanceTimersByTimeAsync(15_000);
      }

      expect(inst.state).toMatchObject({
        status: "error",
        message: expect.stringMatching(/Couldn't connect to the remote agent after 5s/i),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails fast on auth errors without waiting for the connect budget", async () => {
    const h = harness();
    const inst = new SandboxInstance(config("sb-remote"), h.deps);
    await inst.start();
    h.lastAgentCb()!.onError?.(new Error("Unexpected server response: 401"));
    expect(inst.state).toMatchObject({
      status: "error",
      message: expect.stringMatching(/Invalid API key/i),
    });
  });

  it("retryConnect resets the budget and tries again", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.setConnectBudgetMs(1_000);
      const inst = new SandboxInstance(config("sb-remote"), h.deps);
      await inst.start();
      h.lastAgentCb()!.onClose();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(inst.state.status).toBe("error");

      const retry = await inst.retryConnect();
      expect(retry).toEqual({ ok: true });
      expect(inst.state.status).toBe("running");
      expect(h.connectCount()).toBe(2);

      h.lastAgentCb()!.onReady(EXPECTED_SANDBOX_AGENT_VERSION, {});
      expect(inst.state.status).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuild stops then starts again", async () => {
    const h = harness();
    const inst = new SandboxInstance(config("sb-1"), h.deps);
    await inst.start();
    h.lastAgentCb()!.onReady(EXPECTED_SANDBOX_AGENT_VERSION, {});
    await inst.rebuild();
    expect(inst.state.status).toBe("running");
    expect(h.connectCount()).toBe(2); // initial start, then rebuild reconnect
  });
});

describe("SandboxInstance over SSH", () => {
  it("connects through the loopback port the forward hands back", async () => {
    const h = harness();
    const inst = new SandboxInstance(sshConfig("sb-ssh"), h.deps);

    await inst.start();
    await settle();

    expect(h.tunnels).toHaveLength(1);
    expect(h.tunnels[0].alias).toBe("workshop");
    expect(h.lastAgentUrl()).toBe(`ws://127.0.0.1:${h.tunnels[0].localPort}/`);

    h.lastAgentCb()!.onReady(EXPECTED_SANDBOX_AGENT_VERSION, { claude: "2.1" });
    expect(inst.state.status).toBe("connected");
  });

  it("surfaces SSH's host key refusal and never reaches connected", async () => {
    const h = harness();
    const inst = new SandboxInstance(sshConfig("sb-ssh"), h.deps);
    await inst.start();
    await settle();

    h.tunnels[0].die({
      kind: "host-key",
      message: "SSH refused this host: Host key verification failed.",
    });

    expect(inst.state).toMatchObject({
      status: "error",
      message: expect.stringMatching(/host key verification failed/i),
    });
    expect(h.states("sb-ssh")).not.toContain("connected");
  });

  it("errors without opening a forward when the host record is missing", async () => {
    const h = harness();
    const inst = new SandboxInstance({ ...sshConfig("sb-ssh"), sshHost: null }, h.deps);

    const result = await inst.start();
    await settle();

    expect(result.ok).toBe(false);
    expect(inst.state.status).toBe("error");
    expect(h.tunnels).toHaveLength(0);
    expect(h.connectCount()).toBe(0);
  });

  it("reports a host it has not provisioned yet rather than dialing it", async () => {
    const h = harness();
    const inst = new SandboxInstance({ ...sshConfig("sb-ssh"), pairingToken: null }, h.deps);

    const result = await inst.start();
    await settle();

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/not been provisioned/i) });
    expect(h.tunnels).toHaveLength(0);
  });

  it("surfaces a forward that could not be opened at all", async () => {
    const h = harness();
    h.failTunnelOpen("This SSH host is missing its alias.");
    const inst = new SandboxInstance(sshConfig("sb-ssh"), h.deps);

    await inst.start();
    await settle();

    expect(inst.state).toMatchObject({ status: "error", message: /missing its alias/ });
    expect(h.connectCount()).toBe(0);
  });

  it("tears the forward down on stop, leaving no ssh behind", async () => {
    const h = harness();
    const inst = new SandboxInstance(sshConfig("sb-ssh"), h.deps);
    await inst.start();
    await settle();
    expect(h.tunnels[0].closed).toBe(false);

    await inst.stop();

    expect(h.tunnels[0].closed).toBe(true);
  });

  it("tears the forward down on dispose", async () => {
    const h = harness();
    const inst = new SandboxInstance(sshConfig("sb-ssh"), h.deps);
    await inst.start();
    await settle();

    inst.dispose();

    expect(h.tunnels[0].closed).toBe(true);
  });

  it("gives two hosts connected at once their own forwards", async () => {
    const h = harness();
    const reg = new SandboxRegistry(h.deps);

    await reg.start(sshConfig("sb-a", "workshop"));
    await reg.start(sshConfig("sb-b", "attic"));
    await settle();

    expect(h.tunnels.map((t) => t.alias)).toEqual(["workshop", "attic"]);
    expect(h.tunnels[0].localPort).not.toBe(h.tunnels[1].localPort);
  });

  it("reopens the forward on the existing backoff when ssh drops for a passing reason", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const inst = new SandboxInstance(sshConfig("sb-ssh"), h.deps);
      await inst.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.connectCount()).toBe(1);

      // The laptop slept: ssh times out, and the agent WS drops with it. Both
      // paths must land on one retry, not two competing timers.
      h.tunnels[0].die({ kind: "network", message: "Could not reach this host over SSH." });
      h.lastAgentCb()!.onClose();
      expect(inst.state.status).toBe("running");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.connectCount()).toBe(2);
      expect(h.tunnels).toHaveLength(2);
      expect(h.lastAgentUrl()).toBe(`ws://127.0.0.1:${h.tunnels[1].localPort}/`);

      // Nothing else dropped, so nothing else retries.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.connectCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps retrying a refused loopback port — the runtime may still be starting", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const inst = new SandboxInstance(sshConfig("sb-ssh"), h.deps);
      await inst.start();
      await vi.advanceTimersByTimeAsync(0);

      h.lastAgentCb()!.onError?.(new Error("connect ECONNREFUSED 127.0.0.1:40000"));

      expect(inst.state.status).toBe("running");
      h.lastAgentCb()!.onClose();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.connectCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still gives up on an unauthorized agent, forward or not", async () => {
    const h = harness();
    const inst = new SandboxInstance(sshConfig("sb-ssh"), h.deps);
    await inst.start();
    await settle();

    h.lastAgentCb()!.onError?.(new Error("Unexpected server response: 401"));

    expect(inst.state).toMatchObject({ status: "error", message: /Invalid API key/i });
    expect(h.tunnels[0].closed).toBe(true);
  });

  it("times out with SSH wording rather than pointing at a URL and key", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.setConnectBudgetMs(5_000);
      const inst = new SandboxInstance(sshConfig("sb-ssh"), h.deps);
      await inst.start();
      await vi.advanceTimersByTimeAsync(0);

      while (inst.state.status !== "error") {
        h.lastAgentCb()!.onClose();
        await vi.advanceTimersByTimeAsync(15_000);
      }

      expect(inst.state).toMatchObject({
        status: "error",
        message: expect.stringMatching(/reachable over SSH/i),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SandboxInstance idle stop and teardown preference", () => {
  /** An SSH host whose runtime the harness can watch being stopped. */
  function idleHarness(options: { sessions?: number } = {}) {
    const h = harness();
    const stopped: string[] = [];
    let sessions = options.sessions ?? 0;
    const deps: RegistryDeps = {
      ...h.deps,
      countSshSessions: () => sessions,
      stopSshRuntime: async (cfg) => void stopped.push(cfg.sshHost?.alias ?? cfg.id),
    };
    return { ...h, deps, stopped, setSessions: (n: number) => (sessions = n) };
  }

  it("leaves the runtime up on disconnect for a host set to persist", async () => {
    const h = idleHarness();
    const inst = new SandboxInstance(sshConfig("sb-ssh"), h.deps);
    await inst.start();
    await settle();

    await inst.stop();

    expect(h.stopped).toEqual([]);
  });

  it("stops the runtime on disconnect for a host set to tear down", async () => {
    const h = idleHarness();
    const cfg = sshConfig("sb-ssh");
    const inst = new SandboxInstance(
      { ...cfg, sshHost: { ...cfg.sshHost!, onDisconnect: "teardown" } },
      h.deps,
    );
    await inst.start();
    await settle();

    await inst.stop();
    await settle();

    expect(h.stopped).toEqual(["workshop"]);
  });

  it("never stops a remote VM's runtime, which has no such preference", async () => {
    const h = idleHarness();
    const inst = new SandboxInstance(config("sb-1"), h.deps);
    await inst.start();

    await inst.stop();
    await settle();

    expect(h.stopped).toEqual([]);
  });

  it("stops an idle host once its window elapses (AE7)", async () => {
    vi.useFakeTimers();
    try {
      const h = idleHarness({ sessions: 0 });
      const cfg = sshConfig("sb-ssh");
      const inst = new SandboxInstance(
        { ...cfg, sshHost: { ...cfg.sshHost!, idleWindowMinutes: 1 } },
        h.deps,
      );
      await inst.start();
      await vi.advanceTimersByTimeAsync(0);
      h.lastAgentCb()!.onReady(EXPECTED_SANDBOX_AGENT_VERSION, {});

      await vi.advanceTimersByTimeAsync(70_000);

      expect(h.stopped).toEqual(["workshop"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the runtime open for a session waiting at a prompt (AE6)", async () => {
    vi.useFakeTimers();
    try {
      const h = idleHarness({ sessions: 1 });
      const cfg = sshConfig("sb-ssh");
      const inst = new SandboxInstance(
        { ...cfg, sshHost: { ...cfg.sshHost!, idleWindowMinutes: 1 } },
        h.deps,
      );
      await inst.start();
      await vi.advanceTimersByTimeAsync(0);
      h.lastAgentCb()!.onReady(EXPECTED_SANDBOX_AGENT_VERSION, {});

      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(h.stopped).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the idle clock when a session appears and then goes away", async () => {
    vi.useFakeTimers();
    try {
      const h = idleHarness({ sessions: 1 });
      const cfg = sshConfig("sb-ssh");
      const inst = new SandboxInstance(
        { ...cfg, sshHost: { ...cfg.sshHost!, idleWindowMinutes: 2 } },
        h.deps,
      );
      await inst.start();
      await vi.advanceTimersByTimeAsync(0);
      h.lastAgentCb()!.onReady(EXPECTED_SANDBOX_AGENT_VERSION, {});

      // Busy well past the window, so nothing stops.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(h.stopped).toEqual([]);

      // The last session ends; the window starts from here, not from connect.
      h.setSessions(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.stopped).toEqual([]);

      await vi.advanceTimersByTimeAsync(80_000);
      expect(h.stopped).toEqual(["workshop"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never stops a host whose idle window is zero", async () => {
    vi.useFakeTimers();
    try {
      const h = idleHarness({ sessions: 0 });
      const cfg = sshConfig("sb-ssh");
      const inst = new SandboxInstance(
        { ...cfg, sshHost: { ...cfg.sshHost!, idleWindowMinutes: 0 } },
        h.deps,
      );
      await inst.start();
      await vi.advanceTimersByTimeAsync(0);
      h.lastAgentCb()!.onReady(EXPECTED_SANDBOX_AGENT_VERSION, {});

      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

      expect(h.stopped).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops watching once the instance is disposed", async () => {
    vi.useFakeTimers();
    try {
      const h = idleHarness({ sessions: 0 });
      const cfg = sshConfig("sb-ssh");
      const inst = new SandboxInstance(
        { ...cfg, sshHost: { ...cfg.sshHost!, idleWindowMinutes: 1 } },
        h.deps,
      );
      await inst.start();
      await vi.advanceTimersByTimeAsync(0);
      h.lastAgentCb()!.onReady(EXPECTED_SANDBOX_AGENT_VERSION, {});

      inst.dispose();
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      // Disposal is the app quitting, not the user asking for a teardown.
      expect(h.stopped).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SandboxRegistry", () => {
  it("keeps per-sandbox state isolated", async () => {
    const h = harness();
    const reg = new SandboxRegistry(h.deps);
    await reg.start(config("sb-a"));
    await reg.start(config("sb-b"));
    expect(reg.allStates().map((s) => s.sandboxId).sort()).toEqual(["sb-a", "sb-b"]);
    expect(reg.getState("sb-a")!.status).toBe("running");
    expect(reg.getState("sb-b")!.status).toBe("running");
  });

  it("destroy drops the instance", async () => {
    const h = harness();
    const reg = new SandboxRegistry(h.deps);
    await reg.start(config("sb-x"));
    const r = await reg.destroy(config("sb-x"));
    expect(r.ok).toBe(true);
    expect(reg.get("sb-x")).toBeNull();
  });

  it("reconcile starts every enabled sandbox and disposes removed ones", async () => {
    const h = harness();
    const reg = new SandboxRegistry(h.deps);
    await reg.reconcile([config("sb-1"), config("sb-2")]);
    expect(reg.getState("sb-1")!.status).toBe("running");
    expect(reg.getState("sb-2")!.status).toBe("running");
    // sb-2 removed from the set → dropped on next reconcile.
    await reg.reconcile([config("sb-1")]);
    expect(reg.get("sb-2")).toBeNull();
    expect(reg.get("sb-1")).not.toBeNull();
  });
});
