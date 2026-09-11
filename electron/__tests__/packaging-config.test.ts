import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FS_PERMISSION_USAGE_DESCRIPTION_KEYS } from "../../src/shared/fs-permission";
import { PRODUCT_DISPLAY_NAME, USER_DATA_DIR_NAME } from "../../src/shared/user-data-paths";
import { REMOTE_AGENT_COMMAND, REMOTE_AGENT_PACKAGE } from "../../src/shared/ssh-provision";

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

describe("the app's identity (U5)", () => {
  it("asserts the package name, product name and bundle identifier together", () => {
    // Together on purpose: a mismatch between these three is the documented
    // cause of one install resolving two different data directories.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { name?: string; build?: { appId?: string; productName?: string } };

    expect({
      name: pkg.name,
      productName: pkg.build?.productName,
      appId: pkg.build?.appId,
    }).toEqual({
      name: "chaos-wrangler",
      productName: PRODUCT_DISPLAY_NAME,
      appId: "com.shondiaz.chaoswrangler",
    });
  });

  it("moves off the upstream vendor's reverse-DNS namespace", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { build?: { appId?: string } };
    expect(pkg.build?.appId).not.toContain("agentsystem");
  });

  it("keeps the display name spaced and the directory token unspaced (KD13)", () => {
    expect(PRODUCT_DISPLAY_NAME).toContain(" ");
    expect(USER_DATA_DIR_NAME).not.toContain(" ");
    expect(USER_DATA_DIR_NAME).toBe(PRODUCT_DISPLAY_NAME.replace(/ /g, ""));
  });

  it("keeps the upstream agent dependency under its published name (AE5)", () => {
    // The rename stops at this boundary: the package and the binary it
    // publishes are the upstream vendor's, and renaming either reference just
    // stops resolving.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(pkg.dependencies?.["@agentsystemlabs/mission-control-agent"]).toBeTruthy();
    expect(REMOTE_AGENT_COMMAND).toBe("mission-control-agent");
    expect(REMOTE_AGENT_PACKAGE).toBe("@agentsystemlabs/mission-control-agent");
  });
});

describe("artifact naming tolerates the space in the product name (U5)", () => {
  it("keeps the Windows installer filename free of the space", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { build?: { win?: { artifactName?: string } } };
    const template = pkg.build?.win?.artifactName ?? "";

    // Derived from the unspaced package name rather than the spaced product
    // name, so the filename never carries a space to begin with.
    expect(template).toContain("${name}");
    expect(template).not.toContain("${productName}");
  });

  it("quotes every upload glob that a spaced filename would reach", () => {
    for (const workflow of ["ci.yml", "release.yml"]) {
      const yaml = fs.readFileSync(path.join(repoRoot, ".github/workflows", workflow), "utf8");
      for (const line of yaml.split("\n")) {
        const match = /^\s*path:\s*(.+)$/.exec(line);
        if (!match) continue;
        const value = match[1].trim();
        if (!value.includes("*")) continue;
        expect(value.startsWith('"') && value.endsWith('"'), `${workflow}: ${value}`).toBe(true);
      }
    }
  });

  it("invokes no packaging step that the manifest does not define", () => {
    // A step calling an absent script fails the job before it ever packages,
    // which masks a packaging regression in exactly the job meant to catch one.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const defined = new Set(Object.keys(pkg.scripts ?? {}));
    // pnpm's own subcommands are not package scripts.
    const builtIns = new Set([
      "add",
      "audit",
      "config",
      "dedupe",
      "dlx",
      "exec",
      "fetch",
      "install",
      "licenses",
      "list",
      "outdated",
      "pack",
      "patch",
      "prune",
      "publish",
      "rebuild",
      "remove",
      "run",
      "store",
      "update",
      "why",
    ]);

    for (const workflow of ["ci.yml", "release.yml"]) {
      const yaml = fs.readFileSync(path.join(repoRoot, ".github/workflows", workflow), "utf8");
      for (const match of yaml.matchAll(/\bpnpm ([a-z0-9:_-]+)/g)) {
        const invoked = match[1];
        if (builtIns.has(invoked)) continue;
        expect(defined.has(invoked), `${workflow} runs "pnpm ${invoked}"`).toBe(true);
      }
    }
  });
});

describe("user-visible naming (U6)", () => {
  it("names the new product in the screen-capture usage description", () => {
    // macOS shows this string in its own permission prompt, so it has to name
    // the app as the operating system knows it — the bundle name.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { build?: { mac?: { extendInfo?: Record<string, string> } } };
    const description = pkg.build?.mac?.extendInfo?.NSScreenCaptureUsageDescription ?? "";

    expect(description).toContain(PRODUCT_DISPLAY_NAME);
    expect(description).not.toContain("Mission Control");
  });

  it("matches the in-app instruction that points at the same setting", () => {
    // The prompt and the in-app recovery instruction have to name the same
    // thing, or the user is told to look for an app that is not in the list.
    // They were already inconsistent before the rename: the prose said the
    // spaced name while the bundle carried the unspaced one.
    const source = fs.readFileSync(path.join(repoRoot, "src/lib/screenshot.ts"), "utf8");
    expect(source).toContain(PRODUCT_DISPLAY_NAME);
    expect(source).not.toContain("Mission Control");
  });

  it("names the new product in every macOS usage description", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { build?: { mac?: { extendInfo?: Record<string, string> } } };
    const extendInfo = pkg.build?.mac?.extendInfo ?? {};

    for (const [key, value] of Object.entries(extendInfo)) {
      if (!key.endsWith("UsageDescription")) continue;
      expect(value, key).not.toContain("Mission Control");
    }
  });

  it("resolves the window title to the new product name", () => {
    const source = fs.readFileSync(path.join(repoRoot, "src/routes/__root.tsx"), "utf8");
    // Resolved from the shared constant rather than restated, so the title
    // cannot drift from the bundle name.
    expect(source).toContain("{ title: PRODUCT_DISPLAY_NAME }");
    expect(source).not.toContain('title: "MissionControl"');
  });

  it("renders the wordmark as the two words of the new name", () => {
    const source = fs.readFileSync(path.join(repoRoot, "src/components/ui/TopBar.tsx"), "utf8");
    expect(source).toContain("<span>Chaos</span>");
    expect(source).toContain(">Wrangler</span>");
    expect(source).not.toContain("<span>Mission</span>");
  });
});

describe("provenance (R17)", () => {
  const readme = () => fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");

  it("states that this project is a fork and links the original repository", () => {
    const text = readme();
    expect(text).toMatch(/fork of/i);
    expect(text).toContain("https://github.com/AgentSystemLabs/mission-control");
  });

  it("titles itself with the new product name", () => {
    expect(readme().split("\n")[0]).toBe(`# ${PRODUCT_DISPLAY_NAME}`);
  });

  it("leaves the upstream project's name in the license copyright", () => {
    const license = fs.readFileSync(path.join(repoRoot, "LICENSE"), "utf8");
    expect(license).toContain("AgentSystem Labs");
  });
});
