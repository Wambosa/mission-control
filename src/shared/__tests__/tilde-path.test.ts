import { describe, expect, it } from "vitest";
import { expandTilde } from "~/shared/tilde-path";

const HOME = "/Users/tester";

describe("expandTilde", () => {
  it("expands a bare tilde to the home directory", () => {
    expect(expandTilde("~", HOME)).toBe(HOME);
    expect(expandTilde("~/", HOME)).toBe(HOME);
  });

  it("expands a tilde path", () => {
    // The case that failed as "not found": a lookup for a folder called `~`.
    expect(expandTilde("~/Documents/blah", HOME)).toBe("/Users/tester/Documents/blah");
  });

  it("expands a tilde path written with a backslash separator", () => {
    expect(expandTilde("~\\Documents", HOME)).toBe("/Users/tester/Documents");
  });

  it("leaves another user's home alone rather than guessing", () => {
    // `~alice/x` is not this user's home plus a stray segment, and quietly
    // treating it as one would open the wrong directory.
    expect(expandTilde("~alice/notes", HOME)).toBe("~alice/notes");
    expect(expandTilde("~alice", HOME)).toBe("~alice");
  });

  it("leaves a path without a leading tilde untouched", () => {
    expect(expandTilde("/Users/tester/Documents", HOME)).toBe("/Users/tester/Documents");
    expect(expandTilde("relative/path", HOME)).toBe("relative/path");
    expect(expandTilde("", HOME)).toBe("");
    expect(expandTilde("/opt/~/odd", HOME)).toBe("/opt/~/odd");
  });

  it("does not double a separator when the home directory carries one", () => {
    expect(expandTilde("~/Documents", "/Users/tester/")).toBe("/Users/tester/Documents");
  });
});
