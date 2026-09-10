import { describe, expect, it } from "vitest";

import {
  MAX_MIGRATION_SOURCE_BYTES,
  MIGRATION_MARKER_FILENAME,
  MIGRATION_MARKER_VERSION,
  OPTIONAL_MIGRATION_ENTRIES,
  PREVIOUS_USER_DATA_DIR_NAME,
  REQUIRED_MIGRATION_ENTRIES,
  classifyMarker,
  decideMigration,
  detectPreviousStoreDivergence,
  previousDirectoryUnavailableMessage,
  type MigrationMarker,
} from "../user-data-migration";

const IDENTITY = "mig-7f3a91c4";

function marker(overrides: Partial<MigrationMarker> = {}): MigrationMarker {
  return {
    markerVersion: MIGRATION_MARKER_VERSION,
    appVersion: "1.0.0",
    outcome: "migrated",
    sourcePath: "/prev/MissionControl",
    skipped: [],
    identity: IDENTITY,
    fingerprint: null,
    divergenceBaseline: { newestMtimeMs: 1_000, totalBytes: 2_048 },
    ...overrides,
  };
}

function raw(m: MigrationMarker): string {
  return JSON.stringify(m);
}

// ---------------------------------------------------------------------------
// The launch-time predicate. Deliberately first: a copy test passes whether or
// not this is right, and this is the one that decides whether a healthy install
// boots or is declared a failure on its second launch.
// ---------------------------------------------------------------------------

describe("classifyMarker — the launch-time validity predicate", () => {
  it("accepts a marker whose database still carries the recorded identity", () => {
    const result = classifyMarker({
      raw: raw(marker()),
      destinationDbExists: true,
      destinationIdentity: IDENTITY,
    });
    expect(result.kind).toBe("valid");
  });

  it("does not re-compare row counts, so ordinary use since the copy still validates (AE2)", () => {
    // The fingerprint is a copy-time gate. Row counts and page counts move the
    // moment the user creates anything, so re-comparing them at launch would
    // fail every healthy install on its first real launch.
    const withFingerprint = marker({
      fingerprint: {
        source: { pageCount: 10, rowCounts: { projects: 3 } },
        destination: { pageCount: 10, rowCounts: { projects: 3 } },
      },
    });
    const result = classifyMarker({
      raw: raw(withFingerprint),
      destinationDbExists: true,
      destinationIdentity: IDENTITY,
    });
    expect(result.kind).toBe("valid");
  });

  it("reports an absent marker as absent, not as a failure", () => {
    expect(
      classifyMarker({ raw: null, destinationDbExists: false, destinationIdentity: null }).kind,
    ).toBe("absent");
  });

  it("treats a destination directory that exists without a marker as absent (AE8)", () => {
    // The platform creates the destination directory on its own before the app
    // can populate it, which is why the predicate cannot be a directory check.
    expect(
      classifyMarker({ raw: null, destinationDbExists: false, destinationIdentity: null }).kind,
    ).toBe("absent");
  });

  it("is a loud failure when the marker's database is gone", () => {
    const result = classifyMarker({
      raw: raw(marker()),
      destinationDbExists: false,
      destinationIdentity: null,
    });
    expect(result.kind).toBe("database-missing");
  });

  it("is a loud failure when the identity no longer matches", () => {
    const result = classifyMarker({
      raw: raw(marker()),
      destinationDbExists: true,
      destinationIdentity: "mig-somethingelse",
    });
    expect(result.kind).toBe("identity-mismatch");
  });

  it("is a loud failure when the database carries no identity at all", () => {
    // A structurally valid zero-row database passes an integrity check, so
    // integrity checking cannot tell a good copy from an empty one.
    const result = classifyMarker({
      raw: raw(marker()),
      destinationDbExists: true,
      destinationIdentity: null,
    });
    expect(result.kind).toBe("identity-mismatch");
  });

  it("is a loud failure when the marker is newer than this build understands", () => {
    const result = classifyMarker({
      raw: raw(marker({ markerVersion: MIGRATION_MARKER_VERSION + 1 })),
      destinationDbExists: true,
      destinationIdentity: IDENTITY,
    });
    expect(result.kind).toBe("unknown-version");
  });

  it("is a loud failure when the marker does not parse", () => {
    expect(
      classifyMarker({ raw: "{not json", destinationDbExists: true, destinationIdentity: IDENTITY })
        .kind,
    ).toBe("unparseable");
  });

  it("is a loud failure when the marker parses but is not the right shape", () => {
    expect(
      classifyMarker({
        raw: JSON.stringify({ markerVersion: MIGRATION_MARKER_VERSION }),
        destinationDbExists: true,
        destinationIdentity: IDENTITY,
      }).kind,
    ).toBe("unparseable");
  });

  it("accepts a fresh-install marker, which records no source database", () => {
    const result = classifyMarker({
      raw: raw(marker({ outcome: "no-previous-directory", divergenceBaseline: null })),
      destinationDbExists: true,
      destinationIdentity: IDENTITY,
    });
    expect(result.kind).toBe("valid");
  });

  it("accepts a fresh-install marker before the database has been created", () => {
    // The marker is written at startup; the database is created later, by the
    // first connection. A fresh-install marker therefore cannot be asked to
    // vouch for a database's identity — it vouches only that the app has
    // launched here, which is what pins the standalone entry points.
    const result = classifyMarker({
      raw: raw(marker({ outcome: "no-previous-directory", divergenceBaseline: null })),
      destinationDbExists: false,
      destinationIdentity: null,
    });
    expect(result.kind).toBe("valid");
  });

  it("still requires the identity for a marker that records a copy", () => {
    for (const outcome of ["migrated", "migrated-with-skipped"] as const) {
      expect(
        classifyMarker({
          raw: raw(marker({ outcome })),
          destinationDbExists: false,
          destinationIdentity: null,
        }).kind,
        outcome,
      ).toBe("database-missing");
    }
  });
});

// ---------------------------------------------------------------------------
// The decision, in the flowchart's order.
// ---------------------------------------------------------------------------

const probeDefaults = {
  override: null as string | null,
  previousInstanceRunning: false,
  marker: { kind: "absent" } as ReturnType<typeof classifyMarker>,
  previousDirectoryReadable: true,
  sourceDatabasePresent: true,
  sourceDatabaseReadable: true,
  destinationHasDatabase: false,
  sourceBytes: 7 * 1024 * 1024,
  freeBytesAtSource: 1024 * 1024 * 1024,
  freeBytesAtDestination: 1024 * 1024 * 1024,
};

describe("decideMigration — the flowchart", () => {
  it("uses the override and attempts nothing else (AE7)", () => {
    const decision = decideMigration({ ...probeDefaults, override: "/tmp/override" });
    expect(decision).toMatchObject({ action: "use-override", directory: "/tmp/override" });
  });

  it("prefers the override even with a populated source present", () => {
    const decision = decideMigration({
      ...probeDefaults,
      override: "/tmp/override",
      sourceDatabasePresent: true,
      previousInstanceRunning: true,
    });
    expect(decision.action).toBe("use-override");
  });

  it("refuses to start when a previous instance holds the data (AE11)", () => {
    const decision = decideMigration({ ...probeDefaults, previousInstanceRunning: true });
    expect(decision.action).toBe("refuse");
  });

  it("checks the lock above the marker, so the post-migration window is covered", () => {
    // After a successful migration two live copies of the same credentials
    // exist. Checking only on the migrating launch would leave that open.
    const decision = decideMigration({
      ...probeDefaults,
      previousInstanceRunning: true,
      marker: { kind: "valid", marker: marker() },
    });
    expect(decision.action).toBe("refuse");
  });

  it("uses the destination when the marker is valid", () => {
    const decision = decideMigration({
      ...probeDefaults,
      marker: { kind: "valid", marker: marker() },
    });
    expect(decision.action).toBe("use-destination");
  });

  it("records a fresh install when the previous directory has no database (AE22)", () => {
    const decision = decideMigration({
      ...probeDefaults,
      sourceDatabasePresent: false,
      sourceDatabaseReadable: false,
    });
    expect(decision).toMatchObject({ action: "record-fresh-install" });
  });

  it("fails rather than reporting a fresh install when the source will not open (AE3)", () => {
    // Reporting this as a fresh install would stand up a second empty database
    // beside data the user still has.
    const decision = decideMigration({
      ...probeDefaults,
      sourceDatabasePresent: true,
      sourceDatabaseReadable: false,
    });
    expect(decision.action).toBe("fail");
  });

  it("reports a conflict when the destination already carries a database (AE17)", () => {
    const decision = decideMigration({ ...probeDefaults, destinationHasDatabase: true });
    expect(decision.action).toBe("report-conflict");
  });

  it("copies when the source fits and there is room at both ends", () => {
    expect(decideMigration(probeDefaults).action).toBe("copy");
  });

  it("fails rather than copying a source over the size limit (R23)", () => {
    const decision = decideMigration({
      ...probeDefaults,
      sourceBytes: MAX_MIGRATION_SOURCE_BYTES + 1,
    });
    expect(decision.action).toBe("fail");
    if (decision.action === "fail") {
      expect(decision.reason).toContain("512");
    }
  });

  it("fails with the required and available amounts when the destination is full", () => {
    const decision = decideMigration({
      ...probeDefaults,
      sourceBytes: 100 * 1024 * 1024,
      freeBytesAtDestination: 1024,
    });
    expect(decision.action).toBe("fail");
    if (decision.action === "fail") {
      expect(decision.reason).toMatch(/\d/);
      expect(decision.reason.toLowerCase()).toContain("space");
    }
  });

  it("fails when the source volume has no headroom either", () => {
    // Taking the lock opens the previous database read-write, which can rewrite
    // its sidecars — so the source end needs room too.
    const decision = decideMigration({
      ...probeDefaults,
      freeBytesAtSource: 1024,
    });
    expect(decision.action).toBe("fail");
  });

  it("refuses to start when the previous directory cannot be opened either (AE24)", () => {
    const decision = decideMigration({
      ...probeDefaults,
      previousDirectoryReadable: false,
      sourceDatabasePresent: false,
      sourceDatabaseReadable: false,
    });
    expect(decision.action).toBe("refuse-unavailable");
  });

  it("fails loudly rather than reporting a fresh install on a broken marker", () => {
    for (const broken of [
      { kind: "identity-mismatch", expected: IDENTITY, found: null },
      { kind: "database-missing" },
      { kind: "unknown-version", version: 99 },
      { kind: "unparseable", detail: "bad json" },
    ] as ReturnType<typeof classifyMarker>[]) {
      const decision = decideMigration({ ...probeDefaults, marker: broken });
      expect(decision.action, `${broken.kind} must not be silently retried`).toBe("fail");
    }
  });
});

describe("previousDirectoryUnavailableMessage (AE24)", () => {
  const message = previousDirectoryUnavailableMessage({
    previousDir: "/prev/MissionControl",
    destinationDir: "/new/ChaosWrangler",
  });

  it("names both directories and the override variable", () => {
    expect(message).toContain("/prev/MissionControl");
    expect(message).toContain("/new/ChaosWrangler");
    expect(message).toContain("MC_USER_DATA_DIR");
  });
});

describe("detectPreviousStoreDivergence (AE21)", () => {
  const baseline = { newestMtimeMs: 1_000, totalBytes: 2_048 };

  it("reports divergence when the previous write-ahead log alone is newer", () => {
    // Writes land in the log, so the database file can sit unchanged for weeks
    // while the previous install is in daily use.
    const result = detectPreviousStoreDivergence(baseline, {
      newestMtimeMs: 5_000,
      totalBytes: 2_048,
    });
    expect(result.diverged).toBe(true);
    expect(result.nextBaseline).toEqual({ newestMtimeMs: 5_000, totalBytes: 2_048 });
  });

  it("reports divergence when only the size moved", () => {
    expect(
      detectPreviousStoreDivergence(baseline, { newestMtimeMs: 1_000, totalBytes: 9_999 }).diverged,
    ).toBe(true);
  });

  it("reports nothing when the previous store has not moved", () => {
    const result = detectPreviousStoreDivergence(baseline, { ...baseline });
    expect(result.diverged).toBe(false);
    expect(result.nextBaseline).toEqual(baseline);
  });

  it("does not report again once the baseline has advanced", () => {
    const first = detectPreviousStoreDivergence(baseline, {
      newestMtimeMs: 5_000,
      totalBytes: 4_096,
    });
    expect(first.diverged).toBe(true);

    const second = detectPreviousStoreDivergence(first.nextBaseline, {
      newestMtimeMs: 5_000,
      totalBytes: 4_096,
    });
    expect(second.diverged).toBe(false);
  });

  it("reports nothing when there is no baseline to compare against", () => {
    expect(
      detectPreviousStoreDivergence(null, { newestMtimeMs: 5_000, totalBytes: 1 }).diverged,
    ).toBe(false);
  });

  it("reports nothing when the previous store is gone", () => {
    expect(detectPreviousStoreDivergence(baseline, null).diverged).toBe(false);
  });
});

describe("the allowlist (KTD2)", () => {
  it("requires the database and its write-ahead log, and nothing else", () => {
    expect(REQUIRED_MIGRATION_ENTRIES.map((e) => e.name)).toEqual([
      "missioncontrol.db",
      "missioncontrol.db-wal",
    ]);
  });

  it("does not carry the shared-memory sidecar — the next reader rebuilds it", () => {
    const all = [...REQUIRED_MIGRATION_ENTRIES, ...OPTIONAL_MIGRATION_ENTRIES].map((e) => e.name);
    expect(all).not.toContain("missioncontrol.db-shm");
  });

  it("does not carry the directory-grants file", () => {
    // It records authorizations the operating system has just revoked with the
    // identifier change; carrying it would have the app believe in grants the
    // platform no longer holds.
    const all = [...REQUIRED_MIGRATION_ENTRIES, ...OPTIONAL_MIGRATION_ENTRIES].map((e) => e.name);
    expect(all).not.toContain("directory-grants.json");
  });

  it("does not carry the browser engine's caches or per-origin storage", () => {
    const all = [...REQUIRED_MIGRATION_ENTRIES, ...OPTIONAL_MIGRATION_ENTRIES].map((e) => e.name);
    for (const engine of ["Cache", "Code Cache", "GPUCache", "Local Storage", "Session Storage"]) {
      expect(all).not.toContain(engine);
    }
  });

  it("carries the scratch files and image directories as optional", () => {
    const optional = OPTIONAL_MIGRATION_ENTRIES.map((e) => e.name);
    expect(optional).toContain(".port");
    expect(optional).toContain(".window-bg");
    expect(optional).toContain("project-images");
    expect(optional).toContain("terminal-images");
  });
});

describe("the previous identity is hard-coded (KTD6)", () => {
  it("names the previous directory as a literal, not derived from the new brand", () => {
    expect(PREVIOUS_USER_DATA_DIR_NAME).toBe("MissionControl");
  });

  it("keeps the marker filename stable", () => {
    expect(MIGRATION_MARKER_FILENAME).toMatch(/\.json$/);
  });
});
