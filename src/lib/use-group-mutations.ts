import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createGroup } from "~/lib/group-mutations";

/** Thin hook over `group-mutations` — it only supplies the query client. */
export function useGroupMutations() {
  const queryClient = useQueryClient();

  const create = useCallback(
    (name: string) => createGroup(queryClient, name),
    [queryClient],
  );

  return useMemo(() => ({ createGroup: create }), [create]);
}
