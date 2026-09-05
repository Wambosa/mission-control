import { describe, expect, it } from "vitest";
import { versionCore } from "../semver";

describe("versionCore", () => {
  it("drops prerelease and build suffixes", () => {
    expect(versionCore("v1.2.3-beta.1")).toBe("1.2.3");
    expect(versionCore("2026.05.20-2b5dd59")).toBe("2026.05.20");
    expect(versionCore("1.0.0+build.42")).toBe("1.0.0");
  });
});
