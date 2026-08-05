import {
  EXPECTED_SANDBOX_AGENT_VERSION,
  isSandboxAgentVersionCurrent,
  type OpResult,
  type SandboxConfig,
  type SandboxState,
  type ScopedSandboxState,
} from "./sandbox-types";
import {
  classifyConnectError,
  connectBudgetMs,
  connectTimeoutMessage,
  isFailFastConnectError,
  type ConnectFailureKind,
} from "./sandbox-connect-errors";
import {
  isFailFastSshFailure,
  type SshTunnelCallbacks,
  type SshTunnelHandle,
  type SshTunnelResult,
} from "./ssh-transport";

// Phase 2 core: one remote agent connection per sandbox, all running
// concurrently. This module owns the per-sandbox state machine + the staleness
// guard that makes start/stop/rebuild safe to interleave. Agent I/O is injected
// (RegistryDeps) so the logic is unit-testable; the live wiring lives in the
// manager. See docs/multi-sandbox-plan.md §5.

export type AgentCallbacks = {
  onReady: (version: string, agents: Record<string, string | null>) => void;
  onClose: () => void;
  onError?: (err: Error) => void;
};

export type AgentHandle = { close: () => void };

export type RegistryDeps = {
  /** Open the agent WS for a remote VM; invokes callbacks; returns a handle. */
  connectAgent: (
    config: SandboxConfig,
    agentUrl: string,
    token: string,
    cb: AgentCallbacks,
  ) => AgentHandle;
  /** Push a state change to the renderer, tagged with the sandbox id. */
  emitState: (sandboxId: string, state: SandboxState) => void;
  /** Override connect retry budget (tests). */
  connectBudgetMs?: (kind: SandboxConfig["kind"]) => number;
  /**
   * Forward the host's runtime port back to a loopback port here. Called only
   * for `ssh-host` sandboxes, whose agent URL exists only while the forward does.
   */
  openSshTunnel?: (config: SandboxConfig, cb: SshTunnelCallbacks) => Promise<SshTunnelResult>;
};

const REMOTE_CONFIG_ERROR = "Remote sandbox is missing an agent URL or API key.";
const REMOTE_PAUSED_ERROR = "Remote VM is paused. Resume the VM before connecting.";
const SSH_RECORD_ERROR = "This SSH host is missing its host record. Remove it and add it again.";
const SSH_UNPROVISIONED_ERROR = "This SSH host has not been provisioned yet.";
const SSH_TRANSPORT_ERROR = "SSH hosts are not available in this build.";
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

export class SandboxInstance {
  readonly id: string;
  private config: SandboxConfig;
  private readonly deps: RegistryDeps;
  private _state: SandboxState = { status: "stopped", dockerAvailable: false };
  private agent: AgentHandle | null = null;
  // Bumped on every start/stop/destroy so an in-flight async tail (a slow
  // `compose up`) or a late agent callback can detect it's been superseded.
  private opEpoch = 0;
  private opInFlight = false;
  private manualStop = false;
  // A freshly-started remote agent can take a few seconds to listen, so the
  // first WS connect often fails ("socket hang up"). Retry with backoff until it's
  // up. Last successful URL/token are kept so a reconnect targets the same agent.
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private connectStartedAt: number | null = null;
  private lastAgentUrl: string | null = null;
  private lastToken: string | null = null;
  // Only an `ssh-host` has one. Its agent URL lives and dies with the forward,
  // so a reconnect reopens the tunnel rather than reusing a stale port.
  private tunnel: SshTunnelHandle | null = null;

  constructor(config: SandboxConfig, deps: RegistryDeps) {
    this.id = config.id;
    this.config = config;
    this.deps = deps;
  }

  get state(): SandboxState {
    return this._state;
  }

  /** Adopt the latest persisted config (image/ports/env may have changed). */
  updateConfig(config: SandboxConfig): void {
    this.config = config;
  }

  private get hasAgent(): boolean {
    return this._state.status === "connected" || this._state.status === "update-required";
  }

  private set(next: SandboxState): void {
    this._state = next;
    this.deps.emitState(this.id, next);
  }

  private budgetMs(): number {
    return this.deps.connectBudgetMs?.(this.config.kind) ?? connectBudgetMs(this.config.kind);
  }

  private beginConnectAttempt(): void {
    this.connectStartedAt = Date.now();
    this.reconnectAttempts = 0;
  }

  private connectElapsedMs(): number {
    return this.connectStartedAt == null ? 0 : Date.now() - this.connectStartedAt;
  }

  private isConnectBudgetExceeded(): boolean {
    return this.connectStartedAt != null && this.connectElapsedMs() >= this.budgetMs();
  }

  private failConnect(message: string, epoch: number): void {
    if (this.manualStop || epoch !== this.opEpoch || this._state.status === "error") return;
    this.clearReconnect();
    this.closeAgent();
    this.closeTunnel();
    this.set({ status: "error", message });
  }

  private failConnectIfBudgetExceeded(epoch: number): boolean {
    if (!this.isConnectBudgetExceeded()) return false;
    this.failConnect(connectTimeoutMessage(this.config.kind, this.budgetMs()), epoch);
    return true;
  }

  private get isSshHost(): boolean {
    return this.config.kind === "ssh-host";
  }

  /** Why this sandbox cannot be started at all, or null when it can. */
  private configError(): string | null {
    if (this.isSshHost) {
      if (!this.config.sshHost) return SSH_RECORD_ERROR;
      return this.config.pairingToken ? null : SSH_UNPROVISIONED_ERROR;
    }
    return this.config.remoteAgentUrl && this.config.pairingToken ? null : REMOTE_CONFIG_ERROR;
  }

  async start(): Promise<OpResult> {
    if (this.opInFlight) return { ok: false, error: "A sandbox operation is already in progress." };
    this.opInFlight = true;
    const epoch = ++this.opEpoch;
    this.manualStop = false;
    try {
      if (this.config.remoteStatus === "paused" || this.config.remoteStatus === "pausing") {
        this.set({ status: "stopped", dockerAvailable: true });
        return { ok: false, error: REMOTE_PAUSED_ERROR };
      }
      const configError = this.configError();
      if (configError) {
        this.set({ status: "error", message: configError });
        return { ok: false, error: configError };
      }
      const step = this.isSshHost ? "opening SSH connection" : "connecting to remote agent";
      this.set({ status: "starting", step, since: Date.now() });
      const token = this.config.pairingToken as string;
      // A stop / destroy / newer start landed while we set up — don't clobber
      // that newer state or start connecting.
      if (this.isStale(epoch)) return { ok: true };
      this.beginConnectAttempt();
      this.set({ status: "running", since: this.connectStartedAt ?? Date.now() });
      // An SSH host has no persisted URL — the forward supplies one per attempt.
      this.lastAgentUrl = this.isSshHost ? null : this.config.remoteAgentUrl;
      this.lastToken = token;
      this.connect(token, epoch);
      return { ok: true };
    } finally {
      this.opInFlight = false;
    }
  }

  private isStale(epoch: number): boolean {
    return epoch !== this.opEpoch || this.manualStop;
  }

  /**
   * The loopback URL an SSH host's forward exposes, opening the forward when
   * there isn't a live one. Null means the attempt already failed and said so.
   */
  private async resolveTunnelUrl(epoch: number): Promise<string | null> {
    if (this.tunnel && !this.tunnel.isClosed) return this.tunnel.agentUrl;
    this.closeTunnel();

    const open = this.deps.openSshTunnel;
    if (!open) {
      this.failConnect(SSH_TRANSPORT_ERROR, epoch);
      return null;
    }

    let opened: SshTunnelHandle | null = null;
    const callbacks: SshTunnelCallbacks = {
      onExit: (failure) => {
        if (opened && this.tunnel === opened) this.tunnel = null;
        if (!failure) return;
        // A forward that dies takes the agent with it, so ssh's own refusal is
        // the useful message — not the WebSocket's hang-up a moment later.
        if (isFailFastSshFailure(failure.kind)) this.failConnect(failure.message, epoch);
        else this.scheduleReconnect(epoch);
      },
    };

    const result = await open(this.config, callbacks);
    if (!result.ok) {
      this.failConnect(result.error, epoch);
      return null;
    }
    opened = result.tunnel;
    // ssh can die inside the await; a stop can land there too.
    if (this.isStale(epoch) || result.tunnel.isClosed) {
      result.tunnel.close();
      return null;
    }
    this.tunnel = result.tunnel;
    return result.tunnel.agentUrl;
  }

  /**
   * A refused connection normally means a wrong URL and is worth giving up on.
   * Against an SSH host the URL is our own forward, so a refusal only means the
   * runtime on the far side has not started listening yet — keep retrying.
   */
  private isFailFastAgentError(kind: ConnectFailureKind): boolean {
    if (this.isSshHost && kind === "host") return false;
    return isFailFastConnectError(kind);
  }

  private connect(token: string, epoch: number): void {
    if (this.failConnectIfBudgetExceeded(epoch)) return;
    // A remote VM's URL is already known, so its connect stays synchronous.
    // Only an SSH host has to open a forward first.
    if (this.isSshHost) {
      void this.connectOverSsh(token, epoch);
      return;
    }
    if (this.lastAgentUrl) this.openAgent(this.lastAgentUrl, token, epoch);
  }

  private async connectOverSsh(token: string, epoch: number): Promise<void> {
    const agentUrl = await this.resolveTunnelUrl(epoch);
    if (agentUrl === null || this.isStale(epoch)) return;
    this.lastAgentUrl = agentUrl;
    this.openAgent(agentUrl, token, epoch);
  }

  private openAgent(agentUrl: string, token: string, epoch: number): void {
    this.closeAgent();
    const handle = this.deps.connectAgent(this.config, agentUrl, token, {
      onReady: (version, agents) => {
        if (this.agent !== handle || this.manualStop || epoch !== this.opEpoch) return;
        this.reconnectAttempts = 0;
        this.connectStartedAt = null;
        if (isSandboxAgentVersionCurrent(version)) {
          this.set({ status: "connected", version, agents });
        } else {
          this.set({
            status: "update-required",
            version,
            expectedVersion: EXPECTED_SANDBOX_AGENT_VERSION,
            agents,
          });
        }
      },
      onClose: () => {
        if (this.agent === handle) this.agent = null;
        if (this.manualStop || epoch !== this.opEpoch || this._state.status === "error") return;

        const wasConnected = this.hasAgent;
        if (wasConnected) {
          this.connectStartedAt = Date.now();
        } else if (this.connectStartedAt == null) {
          this.connectStartedAt = Date.now();
        }

        if (this.failConnectIfBudgetExceeded(epoch)) return;

        if (wasConnected || this._state.status === "running") {
          this.set({ status: "running", since: this.connectStartedAt });
        }
        this.scheduleReconnect(epoch);
      },
      onError: (err) => {
        if (this.agent !== handle || this.manualStop || epoch !== this.opEpoch || this._state.status === "error") {
          return;
        }
        const failure = classifyConnectError(err);
        if (this.isFailFastAgentError(failure.kind)) {
          this.failConnect(failure.message, epoch);
        }
      },
    });
    this.agent = handle;
  }

  private scheduleReconnect(epoch: number): void {
    if (this.reconnectTimer || this.manualStop || epoch !== this.opEpoch || this._state.status === "error") {
      return;
    }
    if (!this.lastToken || (!this.isSshHost && !this.lastAgentUrl)) return;
    if (this.failConnectIfBudgetExceeded(epoch)) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualStop || epoch !== this.opEpoch) return;
      this.connect(this.lastToken!, epoch);
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeAgent(): void {
    const old = this.agent;
    this.agent = null;
    old?.close();
  }

  /** Tear the forward down so no `ssh` outlives the sandbox that opened it. */
  private closeTunnel(): void {
    const old = this.tunnel;
    this.tunnel = null;
    old?.close();
  }

  async stop(): Promise<OpResult> {
    if (this.opInFlight) return { ok: false, error: "A sandbox operation is already in progress." };
    this.opInFlight = true;
    this.opEpoch += 1;
    this.manualStop = true;
    this.clearReconnect();
    try {
      this.closeAgent();
      this.closeTunnel();
      this.connectStartedAt = null;
      this.set({ status: "stopped", dockerAvailable: true });
      return { ok: true };
    } finally {
      this.opInFlight = false;
    }
  }

  async rebuild(): Promise<OpResult> {
    const stopped = await this.stop();
    if (!stopped.ok) return stopped;
    return this.start();
  }

  /** Reset the connect budget and try the agent again. */
  retryConnect(): Promise<OpResult> {
    if (this.opInFlight) return Promise.resolve({ ok: false, error: "A sandbox operation is already in progress." });
    if (this._state.status !== "running" && this._state.status !== "error") {
      return Promise.resolve({ ok: false, error: "Sandbox is not waiting to connect." });
    }
    if (!this.lastToken || (!this.isSshHost && !this.lastAgentUrl)) return this.start();
    this.manualStop = false;
    this.clearReconnect();
    this.beginConnectAttempt();
    this.set({ status: "running", since: this.connectStartedAt ?? Date.now() });
    this.connect(this.lastToken, this.opEpoch);
    return Promise.resolve({ ok: true });
  }

  /** Disconnect (and never reconnect). Used by sandbox deletion. */
  async destroy(): Promise<OpResult> {
    this.opEpoch += 1;
    this.manualStop = true;
    this.clearReconnect();
    this.closeAgent();
    this.closeTunnel();
    return { ok: true };
  }

  /** Detach (app quit). */
  dispose(): void {
    this.opEpoch += 1;
    this.manualStop = true;
    this.clearReconnect();
    this.closeAgent();
    this.closeTunnel();
  }
}

export class SandboxRegistry {
  private readonly instances = new Map<string, SandboxInstance>();
  private readonly deps: RegistryDeps;

  constructor(deps: RegistryDeps) {
    this.deps = deps;
  }

  private ensure(config: SandboxConfig): SandboxInstance {
    const existing = this.instances.get(config.id);
    if (existing) {
      existing.updateConfig(config);
      return existing;
    }
    const created = new SandboxInstance(config, this.deps);
    this.instances.set(config.id, created);
    return created;
  }

  get(id: string): SandboxInstance | null {
    return this.instances.get(id) ?? null;
  }

  getState(id: string): SandboxState | null {
    return this.instances.get(id)?.state ?? null;
  }

  allStates(): ScopedSandboxState[] {
    return [...this.instances.values()].map((i) => ({ sandboxId: i.id, state: i.state }));
  }

  start(config: SandboxConfig): Promise<OpResult> {
    return this.ensure(config).start();
  }

  stop(id: string): Promise<OpResult> {
    return this.instances.get(id)?.stop() ?? Promise.resolve({ ok: false, error: "unknown sandbox" });
  }

  rebuild(config: SandboxConfig): Promise<OpResult> {
    return this.ensure(config).rebuild();
  }

  retryConnect(config: SandboxConfig): Promise<OpResult> {
    return this.ensure(config).retryConnect();
  }

  async destroy(config: SandboxConfig): Promise<OpResult> {
    const inst = this.ensure(config);
    const r = await inst.destroy();
    this.instances.delete(config.id);
    return r;
  }

  /**
   * "Keep all running": start every enabled sandbox that isn't already up, and
   * drop instances for sandboxes that no longer exist. Idempotent — safe to call
   * on launch and after any sandbox CRUD.
   */
  async reconcile(configs: SandboxConfig[]): Promise<void> {
    const present = new Set(configs.map((c) => c.id));
    for (const [id, inst] of this.instances) {
      if (!present.has(id)) {
        inst.dispose();
        this.instances.delete(id);
      }
    }
    await Promise.all(
      configs.map((c) => {
        const inst = this.ensure(c);
        const s = inst.state.status;
        return s === "stopped" || s === "error" || s === "disabled"
          ? inst.start()
          : Promise.resolve<OpResult>({ ok: true });
      }),
    );
  }

  disposeAll(): void {
    for (const inst of this.instances.values()) inst.dispose();
    this.instances.clear();
  }
}
