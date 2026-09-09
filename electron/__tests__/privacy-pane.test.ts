import { describe, expect, it, vi } from "vitest";
import {
  PRIVACY_PARENT_ANCHOR,
  openPrivacyPane,
  privacyPaneAnchor,
  privacyPaneUrl,
} from "../privacy-pane";
import { FS_PERMISSION_CATEGORIES } from "../../src/shared/fs-permission";

function deps(overrides: Partial<Parameters<typeof openPrivacyPane>[1]> = {}) {
  return {
    platform: "darwin" as NodeJS.Platform,
    openExternal: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("privacyPaneAnchor", () => {
  it("resolves each declared category to a distinct anchor", () => {
    const anchors = FS_PERMISSION_CATEGORIES.map(privacyPaneAnchor);
    expect(new Set(anchors).size).toBe(FS_PERMISSION_CATEGORIES.length);
    expect(anchors).not.toContain(PRIVACY_PARENT_ANCHOR);
  });

  it("falls back to the parent pane for an unknown category rather than throwing", () => {
    // The anchor set is version-specific; a macOS release that renames one
    // should cost precision, not the jump.
    expect(privacyPaneAnchor("invented")).toBe(PRIVACY_PARENT_ANCHOR);
    expect(privacyPaneAnchor(undefined)).toBe(PRIVACY_PARENT_ANCHOR);
    expect(privacyPaneAnchor({ toString: () => "documents" })).toBe(PRIVACY_PARENT_ANCHOR);
  });

  it("builds a settings URL that carries only the resolved anchor", () => {
    expect(privacyPaneUrl("documents")).toBe(
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_DocumentsFolder",
    );
  });
});

describe("openPrivacyPane", () => {
  it("opens the matching pane for a category in the set", async () => {
    const d = deps();
    await expect(openPrivacyPane("desktop", d)).resolves.toEqual({ ok: true });
    expect(d.openExternal).toHaveBeenCalledWith(privacyPaneUrl("desktop"));
  });

  it("rejects a category outside the closed set without opening anything", async () => {
    const d = deps();
    await expect(openPrivacyPane("root-volume", d)).resolves.toEqual({
      ok: false,
      error: "unknown-category",
    });
    expect(d.openExternal).not.toHaveBeenCalled();
  });

  it("rejects a value shaped like a URL, so the renderer cannot supply a target", async () => {
    // The point of taking a category rather than a URL: a compromised renderer
    // has no way to name what gets opened.
    const d = deps();
    for (const attempt of [
      "https://example.test",
      "file:///etc/passwd",
      "x-apple.systempreferences:com.apple.settings.Anything",
      "documents?Privacy_AllFiles",
    ]) {
      await expect(openPrivacyPane(attempt, d)).resolves.toEqual({
        ok: false,
        error: "unknown-category",
      });
    }
    expect(d.openExternal).not.toHaveBeenCalled();
  });

  it("reports an unsupported platform rather than attempting to open anything", async () => {
    const d = deps({ platform: "win32" });
    await expect(openPrivacyPane("documents", d)).resolves.toEqual({
      ok: false,
      error: "unsupported-platform",
    });
    expect(d.openExternal).not.toHaveBeenCalled();
  });

  it("reports a failure to open rather than throwing", async () => {
    const d = deps({
      openExternal: vi.fn(async () => {
        throw new Error("no handler for scheme");
      }),
    });
    await expect(openPrivacyPane("downloads", d)).resolves.toEqual({
      ok: false,
      error: "no handler for scheme",
    });
  });
});
