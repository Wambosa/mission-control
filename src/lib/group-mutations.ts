import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "~/lib/api";
import { GROUP_COLORS } from "~/lib/design-meta";
import { validateGroupName } from "~/lib/group-name";
import { queryKeys } from "~/queries";
import type { Group } from "~/db/schema";

/**
 * Group writes against the query cache, kept out of the components that call
 * them so the rollback and invalidation paths are testable without rendering.
 *
 * Create follows the rail's optimistic shape: snapshot, write the expected
 * value, then reconcile with server truth or restore and say what failed.
 */
export const OPTIMISTIC_GROUP_ID_PREFIX = "optimistic-group-";

function readGroups(queryClient: QueryClient): Group[] {
  return queryClient.getQueryData<Group[]>(queryKeys.groups) ?? [];
}

/** Mirrors the server's own cycling, so the dot rarely changes color on reconcile. */
function nextGroupColor(existing: Group[]): string {
  return GROUP_COLORS[existing.length % GROUP_COLORS.length] ?? "#ff5a1f";
}

function reportFailure(error: unknown, fallback: string): void {
  toast.error(error instanceof Error ? error.message : fallback);
}

/**
 * Create a group from a typed name. Returns the stored row, or null when the
 * name was refused or the request failed — the caller keeps its field open on
 * null rather than pretending the group exists.
 */
export async function createGroup(
  queryClient: QueryClient,
  rawName: string,
): Promise<Group | null> {
  const previous = readGroups(queryClient);
  const validation = validateGroupName(rawName, previous);
  if (!validation.ok) {
    toast.error(validation.reason);
    return null;
  }
  const { name } = validation;

  const optimistic: Group = {
    id: `${OPTIMISTIC_GROUP_ID_PREFIX}${name}`,
    name,
    color: nextGroupColor(previous),
    sortOrder: previous.length,
    createdAt: Date.now(),
  };
  queryClient.setQueryData<Group[]>(queryKeys.groups, [...previous, optimistic]);

  try {
    const { group } = await api.createGroup({ name });
    queryClient.setQueryData<Group[]>(queryKeys.groups, (current) =>
      (current ?? []).map((g) => (g.id === optimistic.id ? group : g)),
    );
    return group;
  } catch (error) {
    queryClient.setQueryData<Group[]>(queryKeys.groups, previous);
    reportFailure(error, "Could not create the group");
    return null;
  }
}

/** Shared optimistic patch for the two edits that can safely precede the server. */
async function patchGroup(
  queryClient: QueryClient,
  id: string,
  patch: Partial<Pick<Group, "name" | "color">>,
  fallbackMessage: string,
): Promise<Group | null> {
  const previous = readGroups(queryClient);
  queryClient.setQueryData<Group[]>(
    queryKeys.groups,
    previous.map((g) => (g.id === id ? { ...g, ...patch } : g)),
  );

  try {
    const { group } = await api.updateGroup(id, patch);
    queryClient.setQueryData<Group[]>(queryKeys.groups, (current) =>
      (current ?? []).map((g) => (g.id === id ? group : g)),
    );
    return group;
  } catch (error) {
    queryClient.setQueryData<Group[]>(queryKeys.groups, previous);
    reportFailure(error, fallbackMessage);
    return null;
  }
}

/** Rename a group, refusing blank and duplicate names before the request. */
export async function renameGroup(
  queryClient: QueryClient,
  id: string,
  rawName: string,
): Promise<Group | null> {
  const validation = validateGroupName(rawName, readGroups(queryClient), { excludeId: id });
  if (!validation.ok) {
    toast.error(validation.reason);
    return null;
  }
  return patchGroup(queryClient, id, { name: validation.name }, "Could not rename the group");
}

export async function recolorGroup(
  queryClient: QueryClient,
  id: string,
  color: string,
): Promise<Group | null> {
  return patchGroup(queryClient, id, { color }, "Could not recolor the group");
}

/**
 * Delete a group. Deliberately not optimistic: removing the row from the
 * cache trips the stale-scope self-heal in `active-group`, which persists a
 * filter change to settings before the server has answered — so a rollback
 * would restore the group with the operator's filter silently moved.
 *
 * Invalidates projects as well as groups: the server orphans member projects
 * but emits only `group:deleted`, so nothing else refreshes those rows.
 */
export async function deleteGroup(queryClient: QueryClient, id: string): Promise<boolean> {
  try {
    await api.deleteGroup(id);
  } catch (error) {
    reportFailure(error, "Could not delete the group");
    return false;
  }
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.groups }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
  ]);
  return true;
}
