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
