import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type PackageJson = {
  build?: {
    files?: string[];
    extraResources?: Array<{ from?: string; to?: string }>;
    mac?: { extendInfo?: Record<string, unknown> };
  };
};

function readPackageJson(): PackageJson {
  const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageJson;
}

describe("electron-builder package config", () => {
  it("ships the TanStack production server bundle that Electron boots", () => {
    expect(readPackageJson().build?.files).toContain("dist/**/*");
  });

  it("carries no microphone usage string or audio-input entitlement", () => {
    // Voice capture is gone; asking macOS for the mic would prompt the user for
    // a permission the app never uses.
    const extendInfo = readPackageJson().build?.mac?.extendInfo ?? {};
    expect(extendInfo.NSMicrophoneUsageDescription).toBeUndefined();
    const plistPath = path.resolve(__dirname, "..", "..", "build", "entitlements.mac.plist");
    const plist = fs.readFileSync(plistPath, "utf8");
    expect(plist).not.toContain("com.apple.security.device.audio-input");
  });
});
