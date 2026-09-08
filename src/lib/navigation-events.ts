/**
 * Which log events a navigation produces.
 *
 * Kept pure and separate from the router subscription so the decisions that
 * matter — one line per navigation, nothing for a re-render, nothing for
 * pointer or focus activity — are assertable without a router.
 */

/** The parts of a router navigation event this module reads. */
export type NavigationInput = {
  /** True only when the path actually changed; false for a search/hash-only move. */
  pathChanged: boolean;
  /** The resolved pathname being navigated to. */
  toPathname: string;
  /** The pathname navigated away from, if there was one. */
  fromPathname?: string;
  /** The matched route's pattern, e.g. `/projects/$id`. */
  routeId?: string;
  /** The matched route's params. */
  params?: Record<string, string | undefined>;
};

export type LoggedEvent = { event: string } & Record<string, unknown>;

/**
 * The project route's pattern. Opening a project is a navigation rather than a
 * server-side mutation, so R10's "project opened" is derived here — the server
 * never sees it, and instrumenting a project read would fire on every list
 * refresh instead of on the one action the operator took.
 */
const PROJECT_ROUTE_ID = "/projects/$id";

export function navigationEvents(input: NavigationInput): LoggedEvent[] {
  // A route that did not change is not a navigation. This is what keeps
  // re-renders, hovers, focus moves and scrolling out of the log: none of them
  // reach this function at all, and the ones that do reach it with an unchanged
  // path — a search-param write, a hash scroll — are not route changes either.
  if (!input.pathChanged) return [];

  const events: LoggedEvent[] = [
    {
      event: "nav.route",
      to: input.toPathname,
      ...(input.fromPathname !== undefined ? { from: input.fromPathname } : {}),
      ...(input.routeId !== undefined ? { route: input.routeId } : {}),
    },
  ];

  const projectId = input.routeId === PROJECT_ROUTE_ID ? input.params?.id : undefined;
  if (projectId) {
    events.push({ event: "project.opened", projectId });
  }

  return events;
}
