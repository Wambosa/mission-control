import { describe, expect, it } from "vitest";
import { shouldFlashPinnedProjectLogo } from "../project-bar-activity";

describe("shouldFlashPinnedProjectLogo", () => {
  it("does not flash when no CLI session is running", () => {
    expect(shouldFlashPinnedProjectLogo({ cliRunningCount: 0 })).toBe(false);
  });

  it("flashes when at least one CLI session is running", () => {
    expect(shouldFlashPinnedProjectLogo({ cliRunningCount: 1 })).toBe(true);
  });
});
