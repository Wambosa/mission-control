import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { disposeAppSettingsStore, setAppSetting } from "../app-settings-store";
import {
  FS_PERMISSION_OUTCOMES_SETTING_KEY,
  readFsPermissionRecords,
  recordFsPermissionOutcome,
  recordFsPermissionOutcomes,
} from "../fs-permission-state";
import { DECLARED_LOCATIONS } from "../../src/shared/fs-permission";

let userDataDir = "";

function freshUserDataDir(): string {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-fs-permission-"));
  return userDataDir;
}

afterEach(() => {
  disposeAppSettingsStore();
  if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
  userDataDir = "";
});

describe("fs-permission-state", () => {
  it("reports every declared location as never-probed before anything is recorded", () => {
    const records = readFsPermissionRecords(freshUserDataDir());
    expect(records.map((record) => record.category)).toEqual(
      DECLARED_LOCATIONS.map((location) => location.category),
    );
    for (const record of records) {
      expect(record.outcome).toBe("never-probed");
      expect(record.checkedAt).toBeNull();
    }
  });

  it("round-trips an outcome with the time it was taken", () => {
    const dir = freshUserDataDir();
    recordFsPermissionOutcome(dir, "documents", "privacy-blocked", 1_700_000_000_000);

    const record = readFsPermissionRecords(dir).find((r) => r.category === "documents");
    expect(record).toEqual({
      category: "documents",
      outcome: "privacy-blocked",
      checkedAt: 1_700_000_000_000,
    });
  });

  it("distinguishes an outcome recorded by a previous run from one recorded now", () => {
    const dir = freshUserDataDir();
    const previousRun = 1_700_000_000_000;
    recordFsPermissionOutcome(dir, "desktop", "readable", previousRun);
    const before = readFsPermissionRecords(dir).find((r) => r.category === "desktop");

    const thisRun = previousRun + 86_400_000;
    recordFsPermissionOutcome(dir, "desktop", "readable", thisRun);
    const after = readFsPermissionRecords(dir).find((r) => r.category === "desktop");

    expect(before?.checkedAt).toBe(previousRun);
    expect(after?.checkedAt).toBe(thisRun);
    expect(after?.checkedAt).not.toBe(before?.checkedAt);
  });

  it("leaves the other locations alone when one is recorded", () => {
    const dir = freshUserDataDir();
    recordFsPermissionOutcome(dir, "documents", "readable", 1);
    recordFsPermissionOutcome(dir, "downloads", "absent", 2);

    const byCategory = new Map(
      readFsPermissionRecords(dir).map((record) => [record.category, record]),
    );
    expect(byCategory.get("documents")?.outcome).toBe("readable");
    expect(byCategory.get("downloads")?.outcome).toBe("absent");
    expect(byCategory.get("desktop")?.outcome).toBe("never-probed");
  });

  it("records a sweep's outcomes in one write", () => {
    const dir = freshUserDataDir();
    recordFsPermissionOutcomes(
      dir,
      [
        { category: "documents", outcome: "readable" },
        { category: "removable-volumes", outcome: "unknowable" },
      ],
      5_000,
    );

    const byCategory = new Map(
      readFsPermissionRecords(dir).map((record) => [record.category, record]),
    );
    expect(byCategory.get("documents")).toEqual({
      category: "documents",
      outcome: "readable",
      checkedAt: 5_000,
    });
    expect(byCategory.get("removable-volumes")?.outcome).toBe("unknowable");
  });

  it("falls back to never-probed when the stored value is not usable JSON", () => {
    const dir = freshUserDataDir();
    setAppSetting(dir, FS_PERMISSION_OUTCOMES_SETTING_KEY, "{ not json");
    for (const record of readFsPermissionRecords(dir)) {
      expect(record.outcome).toBe("never-probed");
    }
  });

  it("ignores a stored entry whose category or outcome is no longer recognised", () => {
    const dir = freshUserDataDir();
    setAppSetting(
      dir,
      FS_PERMISSION_OUTCOMES_SETTING_KEY,
      JSON.stringify({
        documents: { outcome: "readable", checkedAt: 7 },
        "retired-category": { outcome: "readable", checkedAt: 7 },
        desktop: { outcome: "invented-outcome", checkedAt: 7 },
      }),
    );

    const byCategory = new Map(
      readFsPermissionRecords(dir).map((record) => [record.category, record]),
    );
    expect(byCategory.get("documents")?.outcome).toBe("readable");
    expect(byCategory.get("desktop")?.outcome).toBe("never-probed");
    expect(byCategory.has("retired-category" as never)).toBe(false);
  });
});
