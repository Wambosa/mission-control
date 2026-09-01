import { describe, expect, it } from "vitest";
import { projectHostLabel } from "../project-host-label";
import type { SandboxPublicView } from "~/shared/sandbox";

const host = (id: string, name: string) => ({ id, name }) as SandboxPublicView;

describe("projectHostLabel", () => {
  it("reads Local for a project with no host", () => {
    expect(projectHostLabel(null, [host("sb-1", "Big Sur")])).toBe("Local");
    expect(projectHostLabel(undefined, undefined)).toBe("Local");
  });

  it("names the host a project points at", () => {
    expect(projectHostLabel("sb-1", [host("sb-1", "Big Sur"), host("sb-2", "Ada")])).toBe("Big Sur");
  });

  // Saying "Local" here would claim the project runs on this machine when its
  // sessions ran somewhere this client can no longer see.
  it("falls back to the id rather than claiming Local for an unknown host", () => {
    expect(projectHostLabel("sb-gone", [host("sb-1", "Big Sur")])).toBe("sb-gone");
    expect(projectHostLabel("sb-gone", undefined)).toBe("sb-gone");
  });
});
