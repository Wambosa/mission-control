import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FS_PERMISSION_USAGE_DESCRIPTION_KEYS } from "../../src/shared/fs-permission";

type PackageJson = {
  build?: {
    files?: string[];
    extraResources?: Array<{ from?: string; to?: string }>;
    mac?: { extendInfo?: Record<string, unknown> };
    directories?: { output?: string };
    productName?: string;
  };
};

const repoRoot = path.resolve(__dirname, "..", "..");

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as PackageJson;
}

/**
 * Pull the `<key>…</key><string>…</string>` pairs out of a plist.
 *
 * Deliberately not a general plist parser — Info.plist usage descriptions are
 * always string-valued at the top level, and a parser dependency for five keys
 * is not worth the supply chain.
 */
export function readPlistStrings(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pair = /<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  for (const match of xml.matchAll(pair)) out[match[1]] = match[2];
  return out;
}

/** Which of `keys` the plist does not declare with a non-empty string. */
export function missingUsageDescriptions(xml: string, keys: readonly string[]): string[] {
  const strings = readPlistStrings(xml);
  return keys.filter((key) => !strings[key] || strings[key].trim() === "");
}

/**
 * The Info.plist of a packaged build, or null when nothing has been packaged.
 *
 * electron-builder writes to a sibling of the repo (see `build.directories.output`)
 * and names the app directory per architecture, so both are resolved rather
 * than hard-coded.
 */
function builtInfoPlistPath(): string | null {
  const pkg = readPackageJson();
  const outputDir = path.resolve(repoRoot, pkg.build?.directories?.output ?? "dist-electron-out");
  const productName = pkg.build?.productName ?? "MissionControl";
  if (!fs.existsSync(outputDir)) return null;
  for (const entry of fs.readdirSync(outputDir)) {
    if (!entry.startsWith("mac")) continue;
    const plist = path.join(outputDir, entry, `${productName}.app`, "Contents", "Info.plist");
    if (fs.existsSync(plist)) return plist;
  }
  return null;
}

const PLIST_WITH_EVERY_KEY = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  "<plist><dict>",
  ...FS_PERMISSION_USAGE_DESCRIPTION_KEYS.map(
    (key) => `<key>${key}</key><string>because a session may read files there</string>`,
  ),
  "</dict></plist>",
].join("\n");

describe("electron-builder package config", () => {
  it("ships the TanStack production server bundle that Electron boots", () => {
    expect(readPackageJson().build?.files).toContain("dist/**/*");
  });

  it("carries no microphone usage string or audio-input entitlement", () => {
    // Voice capture is gone; asking macOS for the mic would prompt the user for
    // a permission the app never uses.
    const extendInfo = readPackageJson().build?.mac?.extendInfo ?? {};
    expect(extendInfo.NSMicrophoneUsageDescription).toBeUndefined();
    const plistPath = path.resolve(repoRoot, "build", "entitlements.mac.plist");
    const plist = fs.readFileSync(plistPath, "utf8");
    expect(plist).not.toContain("com.apple.security.device.audio-input");
  });
});

describe("protected-location usage descriptions", () => {
  // The authoritative assertion is against the built plist. The packaging tool
  // injects keys of its own, so a package.json check can only prove presence,
  // never absence — which is exactly the blind spot the microphone assertion
  // above has. Presence in extendInfo is still a necessary condition and the
  // one a developer can check without a ten-minute build, so it is asserted
  // separately and labelled as the weaker of the two.
  it("declares every protected location in extendInfo (necessary, not sufficient)", () => {
    const extendInfo = readPackageJson().build?.mac?.extendInfo ?? {};
    for (const key of FS_PERMISSION_USAGE_DESCRIPTION_KEYS) {
      expect(typeof extendInfo[key], `${key} missing from build.mac.extendInfo`).toBe("string");
      expect(String(extendInfo[key]).trim().length).toBeGreaterThan(0);
    }
  });

  it("reports nothing missing from a plist that declares every key", () => {
    expect(
      missingUsageDescriptions(PLIST_WITH_EVERY_KEY, FS_PERMISSION_USAGE_DESCRIPTION_KEYS),
    ).toEqual([]);
  });

  it("reports a key the plist omits", () => {
    const dropped = FS_PERMISSION_USAGE_DESCRIPTION_KEYS[0];
    const withoutOne = PLIST_WITH_EVERY_KEY.split("\n")
      .filter((line) => !line.includes(`<key>${dropped}</key>`))
      .join("\n");
    expect(
      missingUsageDescriptions(withoutOne, FS_PERMISSION_USAGE_DESCRIPTION_KEYS),
    ).toEqual([dropped]);
  });

  it("reports a key the plist declares with an empty string", () => {
    const dropped = FS_PERMISSION_USAGE_DESCRIPTION_KEYS[1];
    const emptied = PLIST_WITH_EVERY_KEY.replace(
      new RegExp(`(<key>${dropped}</key><string>)[^<]*(</string>)`),
      "$1$2",
    );
    expect(missingUsageDescriptions(emptied, FS_PERMISSION_USAGE_DESCRIPTION_KEYS)).toEqual([
      dropped,
    ]);
  });

  const plistPath = builtInfoPlistPath();
  it.skipIf(plistPath === null)(
    "declares every protected location in the built app's Info.plist",
    () => {
      const xml = fs.readFileSync(plistPath as string, "utf8");
      expect(missingUsageDescriptions(xml, FS_PERMISSION_USAGE_DESCRIPTION_KEYS)).toEqual([]);
    },
  );
});
