import { projectIdFromPath } from "~/lib/project-id-from-path";

/**
 * Which visible rail entry the current route selects, or -1 for none.
 *
 * Off a project route — Settings, Usage, the dashboard — nothing is selected,
 * and a project that is real but filtered out of the rail is not selected
 * either: the ring marks a row that is actually on screen.
 */
export function activeRailIndex(visible: Array<{ id: string }>, pathname: string): number {
  const activeId = projectIdFromPath(pathname);
  if (activeId === null) return -1;
  return visible.findIndex((p) => p.id === activeId);
}
