// Regenerates the packaged app-icon assets from two master PNGs.
//
// Why this exists: electron-builder, when handed only `build/icon.png`,
// synthesizes `icon.icns` by stuffing PNG payloads into the `icp4`/`icp5`/`icp6`
// (16/32/64px) member slots. macOS's icon decoder does not reliably decode PNG
// in those small slots and renders color noise instead of the artwork — visible
// as a garbled title-bar / Dock / Finder icon at small sizes. Building the icns
// with Apple's own `iconutil` uses the native `ic04`/`ic05` (ARGB) small-size
// members, which macOS decodes correctly.
//
// Two masters, not one: below 64 pixels the network glyph resolves as a yellow
// smear and crowds the creature, so those members come from a second master
// that omits the glyph and scales the creature up into the freed space. The
// pipeline resizes without simplifying, and the sizes that need simplifying are
// exactly the ones this script exists to get right.
//
// Run on macOS (needs `sips` + `iconutil`) whenever either master changes:
//   pnpm gen:icons
// The generated `build/icon.icns` and `build/icon.ico` are committed so that
// cross-platform builds (incl. CI on non-macOS) consume the known-good files
// directly instead of letting electron-builder synthesize a broken icns.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "build", "icon.png");
const SRC_SMALL = path.join(ROOT, "build", "icon-small.png");
const OUT_ICNS = path.join(ROOT, "build", "icon.icns");
const OUT_ICO = path.join(ROOT, "build", "icon.ico");

/** Below this, the full artwork stops reading and the simplified master takes over. */
const SIMPLIFIED_BELOW_PX = 64;

/**
 * The master a given member is cut from.
 *
 * Both the icns member loop and the ico size loop go through this, so the two
 * platforms cannot drift on where the threshold sits.
 */
const masterFor = (size) => (size < SIMPLIFIED_BELOW_PX ? SRC_SMALL : SRC);

if (process.platform !== "darwin") {
  console.error(
    "[gen:icons] Skipping: this generator needs macOS `iconutil`/`sips`.\n" +
      "            The committed build/icon.icns and build/icon.ico are used as-is.",
  );
  process.exit(0);
}

for (const master of [SRC, SRC_SMALL]) {
  if (!existsSync(master)) {
    console.error(`[gen:icons] Missing master icon: ${master}`);
    process.exit(1);
  }
}

const sips = (args) => execFileSync("sips", args, { stdio: ["ignore", "ignore", "inherit"] });

const work = mkdtempSync(path.join(tmpdir(), "mc-icons-"));
try {
  // ---- macOS .icns via iconutil (native ic04/ic05 small members) ----
  const iconset = path.join(work, "icon.iconset");
  execFileSync("mkdir", ["-p", iconset]);
  const icnsMembers = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  for (const [size, name] of icnsMembers) {
    sips([
      "-s",
      "format",
      "png",
      "-z",
      String(size),
      String(size),
      masterFor(size),
      "--out",
      path.join(iconset, name),
    ]);
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", OUT_ICNS]);
  console.error(`[gen:icons] Wrote ${path.relative(ROOT, OUT_ICNS)}`);

  // ---- Windows .ico (PNG-embedded, multi-size) ----
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = icoSizes.map((size) => {
    const p = path.join(work, `ico_${size}.png`);
    sips(["-s", "format", "png", "-z", String(size), String(size), masterFor(size), "--out", p]);
    return { size, data: readFileSync(p) };
  });
  writeFileSync(OUT_ICO, buildIco(pngs));
  console.error(`[gen:icons] Wrote ${path.relative(ROOT, OUT_ICO)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

// Assemble a PNG-embedded .ico (ICONDIR + entries + concatenated PNGs).
// Windows Vista+ decodes PNG-in-ICO natively.
function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  images.forEach((img, i) => {
    const base = i * 16;
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, base + 0); // width (0 => 256)
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, base + 1); // height
    dir.writeUInt8(0, base + 2); // palette
    dir.writeUInt8(0, base + 3); // reserved
    dir.writeUInt16LE(1, base + 4); // color planes
    dir.writeUInt16LE(32, base + 6); // bits per pixel
    dir.writeUInt32LE(img.data.length, base + 8); // size in bytes
    dir.writeUInt32LE(offset, base + 12); // offset
    offset += img.data.length;
  });

  return Buffer.concat([header, dir, ...images.map((img) => img.data)]);
}
