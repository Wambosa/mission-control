import { getStringAppSetting, setAppSetting } from "./app-settings-store";
import {
  DECLARED_LOCATIONS,
  isFsPermissionCategory,
  type FsPermissionCategory,
  type FsPermissionOutcome,
  type FsPermissionRecord,
} from "../src/shared/fs-permission";

/**
 * What the last probe of each protected location found, and when.
 *
 * Lives in the app-settings store both processes already read directly, so a
 * spawn in main and the Diagnostics panel see the same record without a round
 * trip. The timestamp is what makes a grant from a previous build legible as
 * stale rather than current — with ad-hoc signing a grant does not survive a
 * rebuild, so "readable, two builds ago" is a materially different claim from
 * "readable, this launch".
 */

export const FS_PERMISSION_OUTCOMES_SETTING_KEY = "fs_permission_outcomes";

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<FsPermissionOutcome>([
  "readable",
  "privacy-blocked",
  "filesystem-blocked",
  "absent",
  "unknowable",
  "pending",
  "never-probed",
]);

type StoredEntry = { outcome: FsPermissionOutcome; checkedAt: number | null };
type StoredMap = Partial<Record<FsPermissionCategory, StoredEntry>>;

function readStored(userDataDir: string): StoredMap {
  const raw = getStringAppSetting(userDataDir, FS_PERMISSION_OUTCOMES_SETTING_KEY);
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A record we cannot read is not a record. Reporting never-probed is the
    // honest answer; inventing one would put a claim on screen the app cannot
    // support.
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};

  const out: StoredMap = {};
  for (const [category, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isFsPermissionCategory(category)) continue;
    if (typeof value !== "object" || value === null) continue;
    const { outcome, checkedAt } = value as { outcome?: unknown; checkedAt?: unknown };
    if (typeof outcome !== "string" || !KNOWN_OUTCOMES.has(outcome)) continue;
    out[category] = {
      outcome: outcome as FsPermissionOutcome,
      checkedAt: typeof checkedAt === "number" && Number.isFinite(checkedAt) ? checkedAt : null,
    };
  }
  return out;
}

function writeStored(userDataDir: string, stored: StoredMap): void {
  setAppSetting(userDataDir, FS_PERMISSION_OUTCOMES_SETTING_KEY, JSON.stringify(stored));
}

/** Every declared location, in declaration order, with its last known outcome. */
export function readFsPermissionRecords(userDataDir: string): FsPermissionRecord[] {
  const stored = readStored(userDataDir);
  return DECLARED_LOCATIONS.map((location) => {
    const entry = stored[location.category];
    return {
      category: location.category,
      outcome: entry?.outcome ?? "never-probed",
      checkedAt: entry?.checkedAt ?? null,
    };
  });
}

export function recordFsPermissionOutcome(
  userDataDir: string,
  category: FsPermissionCategory,
  outcome: FsPermissionOutcome,
  checkedAt: number = Date.now(),
): void {
  const stored = readStored(userDataDir);
  stored[category] = { outcome, checkedAt };
  writeStored(userDataDir, stored);
}

/**
 * The persisted record overlaid with whatever this launch's sweep has learned.
 *
 * Until the sweep resolves, some categories have a live answer and the rest
 * have only what a previous launch left behind. Showing the stored value in the
 * gap is right — with its own older timestamp, so it reads as the stale claim
 * it is — and showing "never probed" over the top of it would lose information
 * the operator has.
 */
export function mergeFsPermissionRecords(
  stored: readonly FsPermissionRecord[],
  live: readonly FsPermissionRecord[],
): FsPermissionRecord[] {
  const liveByCategory = new Map(live.map((record) => [record.category, record]));
  return stored.map((record) => {
    const fresh = liveByCategory.get(record.category);
    return fresh && fresh.outcome !== "never-probed" ? fresh : record;
  });
}

/** Record a whole sweep's outcomes under one timestamp and one write. */
export function recordFsPermissionOutcomes(
  userDataDir: string,
  outcomes: ReadonlyArray<{ category: FsPermissionCategory; outcome: FsPermissionOutcome }>,
  checkedAt: number = Date.now(),
): void {
  const stored = readStored(userDataDir);
  for (const { category, outcome } of outcomes) stored[category] = { outcome, checkedAt };
  writeStored(userDataDir, stored);
}
