import type { Group } from "~/db/schema";
import { getSqlite } from "~/db/client";
import { nextGroupColor } from "~/lib/design-meta";
import { events } from "../events";
import { logServerEvent } from "../log-event";
import { ValidationError } from "../errors";
import {
  deleteGroupRow,
  findAllGroups,
  findGroupById,
  insertGroup,
  maxGroupSortOrder,
  updateGroupRow,
  updateGroupSortOrder,
} from "../repositories/groups.repo";
import { orphanProjectsByGroupId } from "../repositories/projects.repo";
import { newId } from "./_ids";

export function listGroups(): Group[] {
  return findAllGroups();
}

/**
 * The authoritative name rule. The client checks the same thing before
 * sending, but an inline field that commits on blur makes the unguarded path
 * easy to reach, and the request schema accepts any non-empty string — so a
 * row of spaces would otherwise be stored.
 *
 * `ValidationError` rather than a plain `Error` on purpose: only a domain
 * error reaches the caller as a 400 carrying its message. A plain one becomes
 * a 500 reading "internal error", which would make the promise that a
 * rejected name says why true of the client check alone.
 */
function validGroupName(raw: string | undefined, existing: Group[], excludeId?: string): string {
  const name = raw?.trim() ?? "";
  if (!name) throw new ValidationError("Group name is required");
  const clash = existing.some((g) => g.id !== excludeId && g.name === name);
  if (clash) throw new ValidationError(`A group named "${name}" already exists`);
  return name;
}

export function createGroup(input: { name: string; color?: string }): Group {
  const existing = listGroups();
  const name = validGroupName(input.name, existing);
  const color = input.color || nextGroupColor(existing.length);
  const row: Group = {
    id: newId("g"),
    name,
    color,
    // Append to the end of the manual order.
    sortOrder: maxGroupSortOrder() + 1,
    createdAt: Date.now(),
  };
  insertGroup(row);
  logServerEvent("group.created", { groupId: row.id });
  events.emit("group:created", { id: row.id });
  return row;
}

export function updateGroup(id: string, patch: Partial<Pick<Group, "name" | "color">>): Group | null {
  const existing = findGroupById(id);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  // A group may keep its own name; only another group's is a clash.
  if (patch.name !== undefined) next.name = validGroupName(patch.name, listGroups(), id);
  updateGroupRow(id, next);
  // Name and colour are the only patchable fields; report which of them moved
  // rather than firing on a save that changed nothing.
  const changedFields = Object.keys(patch).filter(
    (field) => next[field as keyof Group] !== existing[field as keyof Group],
  );
  if (changedFields.length > 0) {
    logServerEvent("group.edited", { groupId: id, fields: changedFields });
  }
  events.emit("group:updated", { id });
  return next;
}

/**
 * Persist a full manual ordering of the groups. `order` must list every group
 * id exactly once; each group's sort_order becomes its index. Backfills legacy
 * NULL rows in one pass.
 */
export function reorderGroups(order: string[]): Group[] {
  const apply = getSqlite().transaction(() => {
    const ids = new Set(findAllGroups().map((g) => g.id));
    if (order.length !== ids.size) {
      throw new ValidationError("order must include every group exactly once");
    }
    const seen = new Set<string>();
    for (const id of order) {
      if (!ids.has(id)) throw new ValidationError(`unknown group ${id}`);
      if (seen.has(id)) throw new ValidationError("duplicate group id in order");
      seen.add(id);
    }
    order.forEach((id, index) => updateGroupSortOrder(id, index));
  });
  apply.immediate();
  for (const id of order) events.emit("group:updated", { id });
  return listGroups();
}

export function deleteGroup(id: string): boolean {
  // orphan projects to ungrouped
  orphanProjectsByGroupId(id);
  const changes = deleteGroupRow(id);
  if (changes > 0) logServerEvent("group.deleted", { groupId: id });
  events.emit("group:deleted", { id });
  return changes > 0;
}
