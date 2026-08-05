import { useEffect, useState } from "react";
import { Btn } from "~/components/ui/Btn";
import { FormErrorBox } from "~/components/ui/FormErrorBox";
import { Icon } from "~/components/ui/Icon";
import { Modal } from "~/components/ui/Modal";
import { EscTooltip } from "~/components/ui/Tooltip";
import { toast } from "sonner";
import { api } from "~/lib/api";
import { getElectron } from "~/lib/electron";
import {
  canProvision,
  describeExistingHarnesses,
  defaultHostName,
  provisioningLabel,
  sshHostRowFromProbe,
  type SshHostRowState,
} from "./add-ssh-host-model";

// Adding a host is picking a name out of the user's own SSH config. There is
// nothing else to ask: no address, no secret, no certificate. Whatever the
// machine is missing, Mission Control installs.

const sectionLabelStyle = {
  fontFamily: "var(--mono)",
  fontSize: 10.5,
  fontWeight: 500,
  color: "var(--text-dim)",
  letterSpacing: "0.05em",
  textTransform: "uppercase",
} as const;

const dimText = { fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.5 } as const;

function StateLine({ state }: { state: SshHostRowState }) {
  const progress = provisioningLabel(state);
  if (progress) {
    return <span style={{ ...dimText, fontFamily: "var(--mono)", fontSize: 11 }}>{progress}</span>;
  }
  if (state.kind === "probing") return <span style={dimText}>Checking…</span>;
  if (state.kind === "connected") return <span style={dimText}>Connected</span>;
  // A refusal is SSH's own words. It is shown as-is, with nothing beside it
  // that would offer to get past it.
  if (state.kind === "refused" || state.kind === "unsupported" || state.kind === "failed") {
    return (
      <span style={{ ...dimText, color: "var(--danger)", whiteSpace: "pre-wrap" }}>
        {state.message}
      </span>
    );
  }
  return null;
}

function PlanSummary({ state }: { state: SshHostRowState }) {
  if (state.kind !== "ready") return null;
  const existing = describeExistingHarnesses(state.plan);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 4 }}>
      {state.summary.length ? (
        <>
          <span style={sectionLabelStyle}>Mission Control will install</span>
          <ul style={{ margin: 0, paddingLeft: 18, ...dimText }}>
            {state.summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      ) : (
        <span style={dimText}>This host already has everything Mission Control needs.</span>
      )}
      {existing.length > 0 && (
        <span style={{ ...dimText, color: "var(--text-faint)" }}>
          Already installed, and left alone: {existing.join(", ")}.
        </span>
      )}
      <span style={{ ...dimText, color: "var(--text-faint)" }}>
        Everything lands in <code style={{ fontFamily: "var(--mono)" }}>{state.plan.prefix}</code>,
        with no sudo and nothing installed system-wide.
      </span>
    </div>
  );
}

export function AddSshHostDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded?: (sandboxId: string) => void;
}) {
  const [aliases, setAliases] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<SshHostRowState>({ kind: "unprobed" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setState({ kind: "unprobed" });
    setError(null);
    setBusy(false);
    const ssh = getElectron()?.sshHosts;
    if (!ssh) {
      setAliases([]);
      return;
    }
    void ssh
      .list()
      .then(setAliases)
      .catch(() => setAliases([]));
  }, [open]);

  const pick = async (alias: string) => {
    setSelected(alias);
    setError(null);
    const ssh = getElectron()?.sshHosts;
    if (!ssh) return;
    setState({ kind: "probing" });
    try {
      setState(sshHostRowFromProbe(await ssh.probe(alias)));
    } catch (e) {
      setState({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const provision = async () => {
    const ssh = getElectron()?.sshHosts;
    if (!ssh?.provision || !selected || !canProvision(state)) return;
    setBusy(true);
    setError(null);
    const stopWatching = ssh.onProvisionProgress?.((event) => {
      if (event.alias !== selected) return;
      setState({
        kind: "provisioning",
        step: event.step,
        index: event.index,
        total: event.total,
      });
    });
    try {
      const result = await ssh.provision(selected);
      if (!result.ok) {
        setState({ kind: "failed", message: result.error });
        setError(result.error);
        return;
      }
      // The host is provisioned; recording it as a scope is what makes it
      // reachable from the switcher.
      const { sandbox } = await api.registerSshHost({
        alias: result.alias,
        name: defaultHostName(result.alias),
        prefix: result.prefix,
        platform: result.platform,
        apiKey: result.apiKey,
      });
      setState({ kind: "connected" });
      for (const harness of result.harnesses) {
        if (harness.status !== "installed") {
          toast.warning(`${harness.agent} is not available on ${result.alias}`, {
            description: harness.detail,
          });
        }
      }
      if (!result.survivesLogout) {
        toast.warning(`${result.alias} could not enable lingering`, {
          description:
            "Sessions survive Mission Control quitting, but the runtime stops when you log out of that host.",
        });
      }
      onAdded?.(sandbox.id);
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setState({ kind: "failed", message });
      setError(message);
    } finally {
      stopWatching?.();
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Add an SSH host"
      width={560}
      footer={
        <>
          <EscTooltip label="Cancel">
            <Btn variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Btn>
          </EscTooltip>
          <Btn
            variant="primary"
            icon="terminal"
            onClick={() => void provision()}
            disabled={!canProvision(state) || busy}
          >
            {busy ? "Setting up…" : "Set up host"}
          </Btn>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <p style={{ margin: 0, ...dimText }}>
          These are the hosts in your SSH config. Mission Control connects the way you already do —
          your keys, your <code style={{ fontFamily: "var(--mono)" }}>known_hosts</code>, your
          settings — and installs whatever the machine is missing.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={sectionLabelStyle}>Hosts in ~/.ssh/config</span>
          {aliases === null ? (
            <span style={dimText}>Reading your SSH config…</span>
          ) : aliases.length === 0 ? (
            <span style={dimText}>
              No usable hosts found. Add one to <code style={{ fontFamily: "var(--mono)" }}>~/.ssh/config</code>{" "}
              and it will appear here.
            </span>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                border: "1px solid var(--border)",
                borderRadius: 7,
                overflow: "hidden",
                maxHeight: 220,
                overflowY: "auto",
              }}
            >
              {aliases.map((alias) => (
                <button
                  key={alias}
                  type="button"
                  onClick={() => void pick(alias)}
                  disabled={busy}
                  aria-pressed={selected === alias}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 10px",
                    background: selected === alias ? "var(--surface-2)" : "var(--surface-0)",
                    border: "none",
                    borderBottom: "1px solid var(--border)",
                    color: "var(--text)",
                    font: "inherit",
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    textAlign: "left",
                    cursor: busy ? "default" : "pointer",
                  }}
                >
                  <Icon name="terminal" size={13} />
                  <span style={{ flex: 1, minWidth: 0 }}>{alias}</span>
                  {selected === alias && <StateLine state={state} />}
                </button>
              ))}
            </div>
          )}
        </div>

        <PlanSummary state={state} />
        <FormErrorBox error={error} />
      </div>
    </Modal>
  );
}
