import {
  isFsPermissionCategory,
  type FsPermissionCategory,
} from "../src/shared/fs-permission";

/**
 * The jump into macOS's privacy settings for a blocked category.
 *
 * The parameter is a category from a closed set, never a URL. That is the whole
 * design: the app's existing external-URL opener takes an arbitrary renderer
 * string and restricts it by scheme, and adding this scheme there would turn it
 * into a general custom-scheme launcher reachable from a compromised renderer.
 * Resolving a fixed anchor from a frozen table in main satisfies that boundary
 * by construction rather than by validation.
 *
 * The anchors are version-specific — verified against macOS 15 — so an unknown
 * one falls back to the parent Files and Folders pane. A less precise jump is
 * the worst outcome; a broken one is not on the table.
 */

const PRIVACY_EXTENSION = "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension";

/** The pane every file-access category lives under. */
export const PRIVACY_PARENT_ANCHOR = "Privacy_FilesAndFolders";

const CATEGORY_ANCHORS: Readonly<Record<FsPermissionCategory, string>> = Object.freeze({
  documents: "Privacy_DocumentsFolder",
  desktop: "Privacy_DesktopFolder",
  downloads: "Privacy_DownloadsFolder",
  "removable-volumes": "Privacy_RemovableVolume",
  "network-volumes": "Privacy_NetworkVolume",
});

/** The anchor for a category, or the parent pane when it is not one we know. */
export function privacyPaneAnchor(category: unknown): string {
  if (!isFsPermissionCategory(category)) return PRIVACY_PARENT_ANCHOR;
  return CATEGORY_ANCHORS[category] ?? PRIVACY_PARENT_ANCHOR;
}

export function privacyPaneUrl(category: unknown): string {
  return `${PRIVACY_EXTENSION}?${privacyPaneAnchor(category)}`;
}

export type PrivacyPaneResult = { ok: true } | { ok: false; error: string };

export type PrivacyPaneDeps = {
  platform: NodeJS.Platform;
  openExternal: (url: string) => Promise<void>;
};

/**
 * Open the privacy pane for `category`.
 *
 * Takes whatever the renderer sent and resolves it against the table; a value
 * outside the set cannot select a target, only the parent pane. Off macOS there
 * is no such pane and nothing is opened.
 */
export async function openPrivacyPane(
  category: unknown,
  deps: PrivacyPaneDeps,
): Promise<PrivacyPaneResult> {
  if (deps.platform !== "darwin") return { ok: false, error: "unsupported-platform" };
  if (!isFsPermissionCategory(category)) return { ok: false, error: "unknown-category" };
  try {
    await deps.openExternal(privacyPaneUrl(category));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
