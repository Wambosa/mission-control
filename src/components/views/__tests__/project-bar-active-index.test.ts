import { describe, expect, it } from "vitest";
import { activeRailIndex } from "../project-bar-active-index";

const visible = [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }];

describe("activeRailIndex", () => {
  it("resolves a visible project's pathname to that project's index", () => {
    expect(activeRailIndex(visible, "/projects/beta")).toBe(1);
  });

  it("resolves a nested project route to the same index", () => {
    expect(activeRailIndex(visible, "/projects/beta/sessions/xyz")).toBe(1);
  });

  it("resolves a non-project route to -1", () => {
    expect(activeRailIndex(visible, "/settings")).toBe(-1);
  });

  it("resolves a project that exists but is not visible in the rail to -1", () => {
    expect(activeRailIndex(visible, "/projects/hidden")).toBe(-1);
  });

  it("resolves the root pathname to -1", () => {
    expect(activeRailIndex(visible, "/")).toBe(-1);
  });

  it("resolves an empty pathname to -1", () => {
    expect(activeRailIndex(visible, "")).toBe(-1);
  });

  it("resolves to -1 when the rail is empty", () => {
    expect(activeRailIndex([], "/projects/beta")).toBe(-1);
  });

  it("follows the project when the visible entries are reordered", () => {
    const reordered = [{ id: "gamma" }, { id: "beta" }, { id: "alpha" }];

    expect(activeRailIndex(visible, "/projects/gamma")).toBe(2);
    expect(activeRailIndex(reordered, "/projects/gamma")).toBe(0);
  });

  it("does not mistake a path that merely starts with the projects segment", () => {
    expect(activeRailIndex(visible, "/projectsomething/beta")).toBe(-1);
  });
});
