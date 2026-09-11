import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createGroup,
  deleteGroup,
  recolorGroup,
  renameGroup,
} from "~/lib/group-mutations";

/** Thin hook over `group-mutations` — it only supplies the query client. */
export function useGroupMutations() {
  const queryClient = useQueryClient();

  const create = useCallback(
    (name: string) => createGroup(queryClient, name),
    [queryClient],
  );
  const rename = useCallback(
    (id: string, name: string) => renameGroup(queryClient, id, name),
    [queryClient],
  );
  const recolor = useCallback(
    (id: string, color: string) => recolorGroup(queryClient, id, color),
    [queryClient],
  );
  const remove = useCallback(
    (id: string) => deleteGroup(queryClient, id),
    [queryClient],
  );

  return useMemo(
    () => ({
      createGroup: create,
      renameGroup: rename,
      recolorGroup: recolor,
      deleteGroup: remove,
    }),
    [create, rename, recolor, remove],
  );
}
