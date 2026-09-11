import { describe, expect, it } from "vitest";

import {
  USER_DATA_DIR_ENV_VAR,
  isDatabaseBusyError,
  previousInstanceRefusal,
  verdictForProbe,
} from "../previous-instance";

describe("verdictForProbe", () => {
  it("reads a busy lock as a running previous instance", () => {
    expect(verdictForProbe({ kind: "busy", detail: "database is locked" })).toBe("running");
  });

  it("reads an acquired lock as nothing running", () => {
    expect(verdictForProbe({ kind: "locked" })).toBe("not-running");
  });

  it("reads a previous directory with no database as nothing running", () => {
    expect(verdictForProbe({ kind: "no-database" })).toBe("not-running");
  });

  it("reads an unreadable previous directory as nothing running", () => {
    // The migration's own source check produces the failure for this case; the
    // guard's only job is to not turn it into a refusal to start.
    expect(verdictForProbe({ kind: "unreadable", detail: "EACCES" })).toBe("not-running");
  });
});

describe("isDatabaseBusyError", () => {
  it("recognizes the driver's busy code", () => {
    const err = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    expect(isDatabaseBusyError(err)).toBe(true);
  });

  it("recognizes a busy recovery code", () => {
    const err = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY_SNAPSHOT" });
    expect(isDatabaseBusyError(err)).toBe(true);
  });

  it("recognizes the message when no code is attached", () => {
    expect(isDatabaseBusyError(new Error("database is locked"))).toBe(true);
  });

  it("does not mistake an unrelated failure for a busy lock", () => {
    const err = Object.assign(new Error("unable to open database file"), {
      code: "SQLITE_CANTOPEN",
    });
    expect(isDatabaseBusyError(err)).toBe(false);
  });

  it("does not mistake a non-error for a busy lock", () => {
    expect(isDatabaseBusyError(undefined)).toBe(false);
    expect(isDatabaseBusyError("database is locked")).toBe(false);
  });
});

describe("previousInstanceRefusal", () => {
  const message = previousInstanceRefusal({
    previousDir: "/Users/tester/Library/Application Support/MissionControl",
  });

  it("names the previous install as the holder", () => {
    expect(message).toContain("/Users/tester/Library/Application Support/MissionControl");
    expect(message.toLowerCase()).toContain("already running");
  });

  it("names the override variable so the operator has a way through", () => {
    expect(message).toContain(USER_DATA_DIR_ENV_VAR);
  });

  it("never suggests the data is lost", () => {
    expect(message.toLowerCase()).not.toContain("lost");
  });
});
