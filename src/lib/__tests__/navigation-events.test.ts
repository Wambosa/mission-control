import { describe, expect, it } from "vitest";
import { navigationEvents, type NavigationInput } from "../navigation-events";

function nav(over: Partial<NavigationInput> = {}): NavigationInput {
  return {
    pathChanged: true,
    toPathname: "/projects/p1",
    fromPathname: "/",
    routeId: "/projects/$id",
    params: { id: "p1" },
    ...over,
  };
}

describe("navigationEvents", () => {
  it("emits one route event per navigation, carrying the resolved route", () => {
    const events = navigationEvents(nav({ routeId: "/settings", params: {} }));
    expect(events).toEqual([
      { event: "nav.route", to: "/projects/p1", from: "/", route: "/settings" },
    ]);
  });

  it("emits exactly two events for two navigations, one each", () => {
    const first = navigationEvents(nav({ toPathname: "/projects/a", params: { id: "a" } }));
    const second = navigationEvents(nav({ toPathname: "/projects/b", params: { id: "b" } }));
    expect(first.filter((e) => e.event === "nav.route")).toHaveLength(1);
    expect(second.filter((e) => e.event === "nav.route")).toHaveLength(1);
  });

  // A re-render, a hover, a focus move and a scroll never change the path.
  // This is the gate that keeps all of them out of the log.
  it("emits nothing when the route did not change", () => {
    expect(navigationEvents(nav({ pathChanged: false }))).toEqual([]);
  });

  it("emits nothing for a search-param or hash write that leaves the path alone", () => {
    expect(
      navigationEvents(nav({ pathChanged: false, toPathname: "/projects/p1" })),
    ).toEqual([]);
  });

  it("omits the origin on the first navigation rather than inventing one", () => {
    const events = navigationEvents(nav({ fromPathname: undefined }));
    expect(events[0]).not.toHaveProperty("from");
    expect(events[0]).toMatchObject({ event: "nav.route", to: "/projects/p1" });
  });

  it("still logs the navigation when the route pattern is unknown", () => {
    const events = navigationEvents(nav({ routeId: undefined }));
    expect(events[0]).not.toHaveProperty("route");
    expect(events[0]).toMatchObject({ event: "nav.route", to: "/projects/p1" });
  });

  describe("project opened (R10)", () => {
    it("reports opening a project alongside the navigation", () => {
      expect(navigationEvents(nav())).toEqual([
        {
          event: "nav.route",
          to: "/projects/p1",
          from: "/",
          route: "/projects/$id",
        },
        { event: "project.opened", projectId: "p1" },
      ]);
    });

    it("does not report a project for any other route", () => {
      const events = navigationEvents(
        nav({ routeId: "/settings", toPathname: "/settings", params: {} }),
      );
      expect(events.map((e) => e.event)).toEqual(["nav.route"]);
    });

    it("does not report a project when the route matched but carries no id", () => {
      const events = navigationEvents(nav({ params: {} }));
      expect(events.map((e) => e.event)).toEqual(["nav.route"]);
    });

    it("does not report a project when the navigation was not a route change", () => {
      expect(navigationEvents(nav({ pathChanged: false }))).toEqual([]);
    });
  });
});
