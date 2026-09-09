import {
  supportsMemoryInjection,
  writeAgentMemoryBlock,
} from "../src/shared/agent-memory-file";
import {
  findDeclaredLocation,
  type FsPermissionRecord,
} from "../src/shared/fs-permission";
import type { MemoryFileFs } from "../src/shared/scaffolding-fs";

/**
 * Tell an agent that some locations on this machine cannot be read (R17, R18).
 *
 * This is an enhancement, not the mechanism. Memory injection supports exactly
 * one agent today, so three of four cannot be warned at all and the silence
 * detector is their only protection — nothing here may be relied on as the fix.
 *
 * The note is written from the record at spawn. A grant that changes
 * mid-session leaves it stale until the next spawn; that is accepted, because
 * rewriting an auto-load file underneath a running agent is worse than a stale
 * sentence in its context.
 */

function blockedLines(records: readonly FsPermissionRecord[]): string[] {
  const lines: string[] = [];
  for (const record of records) {
    if (record.outcome !== "privacy-blocked" && record.outcome !== "filesystem-blocked") continue;
    const label = findDeclaredLocation(record.category)?.label ?? record.category;
    lines.push(
      record.outcome === "privacy-blocked"
        ? `- ${label} — blocked by the macOS privacy gate.`
        : `- ${label} — blocked by ordinary file permissions.`,
    );
  }
  return lines;
}

/** The note's body, or an empty string when nothing is blocked. */
export function blockedLocationNote(records: readonly FsPermissionRecord[]): string {
  const lines = blockedLines(records);
  if (lines.length === 0) return "";
  return [
    "## Filesystem access on this machine",
    "",
    "Reading files in these locations will fail, and may hang rather than error:",
    "",
    ...lines,
    "",
    "Do not retry a read that fails this way. Tell the user to grant access in",
    "Settings → Diagnostics → Folder access, then restart the session.",
  ].join("\n");
}

/**
 * Write (or clear) the permission note in the agent's auto-load file.
 *
 * Fail-soft in every branch, inherited from the writer rather than added here:
 * an unsupported agent gets no note and no error, and a write that fails leaves
 * session start untouched.
 */
export async function installBlockedLocationNote(params: {
  agent: string | undefined;
  cwd: string;
  records: readonly FsPermissionRecord[];
  fs?: MemoryFileFs;
}): Promise<void> {
  const { agent, cwd, records, fs } = params;
  if (!supportsMemoryInjection(agent)) return;
  try {
    await writeAgentMemoryBlock(agent, cwd, "permissions", blockedLocationNote(records), fs);
  } catch {
    /* the writer is already fail-soft; this is the belt to its braces */
  }
}
