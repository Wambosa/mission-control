import type { SandboxPublicView } from "~/shared/sandbox";

/**
 * How the project header names the one machine this project's sessions run on.
 *
 * A project with no host runs on this machine. A project pointing at a host
 * this client cannot see — removed elsewhere, or a database carried between
 * machines — is named by its id rather than silently reading as `Local`: the
 * sessions recorded against it really did run somewhere else, and saying
 * "Local" would misstate that.
 */
export function projectHostLabel(
  sandboxId: string | null | undefined,
  sandboxes: SandboxPublicView[] | undefined,
): string {
  if (!sandboxId) return "Local";
  return sandboxes?.find((sandbox) => sandbox.id === sandboxId)?.name ?? sandboxId;
}
