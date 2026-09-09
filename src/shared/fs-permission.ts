/**
 * The protected filesystem locations the app declares to macOS, and the
 * vocabulary for what a probe of one found.
 *
 * One list, three readers: the packaging config declares a usage description
 * per entry, the launch pre-flight probes each entry, and the Diagnostics
 * panel renders a row per entry. Keeping them on one table is what stops a
 * plist key and a probe from drifting apart.
 */

export const FS_PERMISSION_CATEGORIES = [
  "documents",
  "desktop",
  "downloads",
  "removable-volumes",
  "network-volumes",
] as const;

export type FsPermissionCategory = (typeof FS_PERMISSION_CATEGORIES)[number];

/**
 * What one probe attempt found.
 *
 * macOS exposes no API for the consent state of the file-access family, so
 * none of these is a permission — each is the classified result of a real
 * enumeration, or the reason no enumeration was attempted.
 */
export type FsPermissionOutcome =
  /** The directory enumerated. */
  | "readable"
  /** Rejected above the filesystem: the privacy gate. Grantable via R15's jump. */
  | "privacy-blocked"
  /** An ordinary POSIX permission error. Not grantable in the privacy pane. */
  | "filesystem-blocked"
  /** No such directory on this machine. */
  | "absent"
  /** A volume category with no volume of that class mounted — no state to claim. */
  | "unknowable"
  /** The pre-flight deadline passed with the consent prompt still unanswered. */
  | "pending"
  /** No usable answer: never attempted, or the attempt failed in a way we cannot classify. */
  | "never-probed";

/** A probe outcome plus when it was taken, so a stale grant reads as stale. */
export type FsPermissionRecord = {
  category: FsPermissionCategory;
  outcome: FsPermissionOutcome;
  /** Epoch milliseconds. Wall clock, because this is displayed and compared across runs. */
  checkedAt: number | null;
};

export type FsVolumeClass = "removable" | "network";

export type DeclaredLocation = {
  category: FsPermissionCategory;
  /** The Info.plist key macOS reads when it raises this category's consent prompt. */
  usageDescriptionKey: string;
  /** Directory name under the user's home, or null for a volume category. */
  homeRelativePath: string | null;
  /** Volume categories are probed only when a volume of the class is mounted. */
  volumeClass: FsVolumeClass | null;
  /** Operator-facing row label in Diagnostics. */
  label: string;
};

export const DECLARED_LOCATIONS = [
  {
    category: "documents",
    usageDescriptionKey: "NSDocumentsFolderUsageDescription",
    homeRelativePath: "Documents",
    volumeClass: null,
    label: "Documents folder",
  },
  {
    category: "desktop",
    usageDescriptionKey: "NSDesktopFolderUsageDescription",
    homeRelativePath: "Desktop",
    volumeClass: null,
    label: "Desktop folder",
  },
  {
    category: "downloads",
    usageDescriptionKey: "NSDownloadsFolderUsageDescription",
    homeRelativePath: "Downloads",
    volumeClass: null,
    label: "Downloads folder",
  },
  {
    category: "removable-volumes",
    usageDescriptionKey: "NSRemovableVolumesUsageDescription",
    homeRelativePath: null,
    volumeClass: "removable",
    label: "Removable volumes",
  },
  {
    category: "network-volumes",
    usageDescriptionKey: "NSNetworkVolumesUsageDescription",
    homeRelativePath: null,
    volumeClass: "network",
    label: "Network volumes",
  },
] as const satisfies readonly DeclaredLocation[];

/** Every usage-description key the packaged app must declare. */
export const FS_PERMISSION_USAGE_DESCRIPTION_KEYS: readonly string[] =
  DECLARED_LOCATIONS.map((location) => location.usageDescriptionKey);

export function findDeclaredLocation(
  category: FsPermissionCategory,
): DeclaredLocation | undefined {
  return DECLARED_LOCATIONS.find((location) => location.category === category);
}

export function isFsPermissionCategory(value: unknown): value is FsPermissionCategory {
  return (
    typeof value === "string" &&
    (FS_PERMISSION_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * The protected category a path mentioned in some text belongs to, if any.
 *
 * Used to point a silence alert at the right privacy pane. Deliberately
 * conservative: it only claims a category for a path that plainly sits under
 * one, because offering the wrong row is worse than offering none.
 */
export function fsPermissionCategoryFromText(
  text: string,
  homeDir: string,
): FsPermissionCategory | null {
  const haystack = text.toLowerCase();
  const home = homeDir.toLowerCase().replace(/\/+$/, "");
  for (const location of DECLARED_LOCATIONS) {
    if (!location.homeRelativePath) continue;
    const prefix = `${home}/${location.homeRelativePath.toLowerCase()}`;
    const at = haystack.indexOf(prefix);
    if (at === -1) continue;
    // The path may continue into the folder or stop at it — the commonest real
    // error names the folder itself and then quotes or ends the line. What must
    // not match is a longer sibling name like `Documents-old`.
    const next = haystack[at + prefix.length];
    if (next === undefined || !/[a-z0-9_-]/.test(next)) return location.category;
  }
  // A mount point cannot be told apart from a network share by its path alone,
  // so /Volumes resolves to the removable row and the parent pane covers the rest.
  if (haystack.includes("/volumes/")) return "removable-volumes";
  return null;
}
