import { AGENT_CLI_CONFIG } from "~/shared/agent-cli-config";
import type { SshProbeOutcome, SshProvisionPlan } from "~/shared/ssh-provision";

// The decisions behind the add-host dialog, kept out of the component so they
// can be tested without a browser. What a probe means, what Mission Control
// would install, and whether a host is ready to be worked on.

/** Where one host in the list currently stands. */
export type SshHostRowState =
  | { kind: "unprobed" }
  | { kind: "probing" }
  /** SSH said no. Mission Control reports it and offers nothing to bypass it. */
  | { kind: "refused"; message: string }
  /** Reached, but not a host Mission Control can provision. */
  | { kind: "unsupported"; message: string }
  | { kind: "ready"; plan: SshProvisionPlan; summary: string[] }
  | { kind: "provisioning"; step: string; index: number; total: number }
  | { kind: "connected" }
  /** Provisioned, with something the user should read before the dialog goes. */
  | { kind: "done"; alias: string; notes: SshProvisionNote[] }
  | { kind: "failed"; message: string };

/**
 * What Mission Control would install, in the user's words. An empty list means
 * the host already has everything, which is worth saying rather than showing
 * an empty space.
 */
export function describeProvisionPlan(plan: SshProvisionPlan): string[] {
  const lines: string[] = [];
  for (const step of plan.steps) {
    if (step.kind === "runtime") {
      lines.push(
        step.reason === "outdated"
          ? `Update the Node runtime (this host has ${step.presentVersion ?? "an older build"})`
          : "Install a Node runtime",
      );
    } else if (step.kind === "agent") {
      lines.push(
        step.reason === "outdated" ? "Update the Mission Control agent" : "Install the Mission Control agent",
      );
    } else {
      lines.push(`Install ${AGENT_CLI_CONFIG[step.agent].label}`);
    }
  }
  return lines;
}

/** Harnesses the host already has, which are used as-is and never replaced. */
export function describeExistingHarnesses(plan: SshProvisionPlan): string[] {
  const missing = new Set(
    plan.steps.flatMap((step) => (step.kind === "harness" ? [step.agent] : [])),
  );
  return Object.values(AGENT_CLI_CONFIG)
    .filter((config) => !missing.has(config.agent))
    .map((config) => config.label);
}

/** Turn one probe into the row the dialog shows. */
export function sshHostRowFromProbe(outcome: SshProbeOutcome): SshHostRowState {
  // SSH's refusal is SSH's to explain — a host key or a login is the user's
  // to resolve with ssh, never something to offer to work around here.
  if (!outcome.ok) return { kind: "refused", message: outcome.error };
  if (!outcome.plan.ok) return { kind: "unsupported", message: outcome.plan.message };
  return {
    kind: "ready",
    plan: outcome.plan,
    summary: describeProvisionPlan(outcome.plan),
  };
}

/** Whether provisioning can start from this row. */
export function canProvision(state: SshHostRowState): boolean {
  return state.kind === "ready";
}

/**
 * Whether a host can be chosen as a scope. A host mid-provisioning has no
 * runtime to talk to yet, so offering it would only produce a failed connect.
 */
export function isSelectableScope(state: SshHostRowState): boolean {
  return state.kind === "connected";
}

/** One line describing where provisioning has got to. */
export function provisioningLabel(state: SshHostRowState): string | null {
  if (state.kind !== "provisioning") return null;
  return `${state.step} (${state.index + 1} of ${state.total})`;
}


/** One thing worth telling the user about a host that just provisioned. */
export type SshProvisionNote = {
  tone: "info" | "warn";
  title: string;
  detail?: string;
};

/** The shape of a successful provision, as far as the summary cares. */
export type SshProvisionSummaryInput = {
  alias: string;
  adopted: boolean;
  survivesLogout: boolean;
  claimWarning?: string;
  harnesses: ReadonlyArray<{
    agent: string;
    status: "installed" | "failed" | "unavailable";
    detail?: string;
  }>;
};

/**
 * What a finished provision leaves the user needing to know. A toast is the
 * wrong home for any of it: these fire as the dialog closes, and the one thing
 * worth reading — a harness that did not install, a runtime that was adopted
 * from another Mission Control — scrolls away before it can be read.
 *
 * An empty list means nothing needs saying, and the dialog can just close.
 */
export function provisionNotes(result: SshProvisionSummaryInput): SshProvisionNote[] {
  const notes: SshProvisionNote[] = [];

  // Adoption first: it changes what removing this host will later do.
  if (result.adopted) {
    notes.push({
      tone: "info",
      title: "This host was already running Mission Control",
      detail:
        "Its existing runtime was connected to rather than replaced, so another Mission Control using it keeps working. Removing the host here will leave that runtime running.",
    });
  }

  for (const harness of result.harnesses) {
    if (harness.status === "installed") continue;
    notes.push({
      tone: "warn",
      title:
        harness.status === "failed"
          ? `${harness.agent} failed to install on ${result.alias}`
          : `${harness.agent} is not available on ${result.alias}`,
      detail: harness.detail,
    });
  }

  if (!result.survivesLogout) {
    notes.push({
      tone: "warn",
      title: `${result.alias} could not enable lingering`,
      detail:
        "Sessions survive Mission Control quitting, but the runtime stops when you log out of that host.",
    });
  }

  if (result.claimWarning) {
    notes.push({
      tone: "warn",
      title: `${result.alias} did not record this Mission Control`,
      detail: `${result.claimWarning} The host works, but removing it here may take the runtime away from another Mission Control using it.`,
    });
  }

  return notes;
}

/**
 * Nothing here is a prompt for a URL, a key, or a certificate — reaching a
 * host over SSH needs none of them, and their absence is the visible payoff.
 */
export type AddSshHostSelection = { alias: string; name: string };

/** The name a new host gets: its own alias, which is what the user calls it. */
export function defaultHostName(alias: string): string {
  return alias;
}
