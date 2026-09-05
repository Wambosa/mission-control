import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { getBinding, matchElectronInput } from "../keybindings-reader";

// The main process reads keybindings straight from the settings database,
// independently of the renderer's store. With the default map down to two
// actions, an operator's stored override IS the interesting case: a reader
// that discarded overrides for actions missing from the defaults would
// silently stop honoring nearly every custom binding, with no crash and
// nothing in the log. Nothing else covers this file.
// app-settings-store keeps one process-wide connection to the first database
// it opens, so every case here shares one directory and rewrites the row.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-keybindings-reader-"));

function seedOverrides(overrides: Record<string, unknown>): void {
  const db = new Database(path.join(userDataDir, "missioncontrol.db"));
  db.exec("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("keybindings:global", JSON.stringify(overrides));
  db.close();
}

const custom = { mod: true, shift: true, alt: false, key: "j" };

beforeEach(() => {
  seedOverrides({});
});

describe("getBinding", () => {
  it("honors an override for an action that ships unbound", () => {
    seedOverrides({ "session.closeWindow": custom });
    expect(getBinding(userDataDir, "session.closeWindow")).toEqual(custom);
  });

  it("returns undefined for an action with no override and no default", () => {
    expect(getBinding(userDataDir, "session.closeWindow")).toBeUndefined();
  });

  it("falls back to the default for an action that ships bound", () => {
    expect(getBinding(userDataDir, "file.save")).toEqual({
      mod: true,
      shift: false,
      alt: false,
      key: "s",
    });
  });

  it("prefers an override over the default", () => {
    seedOverrides({ "file.save": custom });
    expect(getBinding(userDataDir, "file.save")).toEqual(custom);
  });

  it("ignores an override naming an action the registry does not have", () => {
    seedOverrides({ "voice.pushToTalk": custom, "session.closeWindow": custom });
    // The retired action is dropped; the real one beside it still applies.
    expect(getBinding(userDataDir, "session.closeWindow")).toEqual(custom);
  });

  it("ignores a malformed override rather than throwing", () => {
    seedOverrides({ "session.closeWindow": { mod: "yes", key: 3 } });
    expect(() => getBinding(userDataDir, "session.closeWindow")).not.toThrow();
    expect(getBinding(userDataDir, "session.closeWindow")).toBeUndefined();
  });
});

describe("matchElectronInput", () => {
  const binding = { mod: true, shift: false, alt: false, key: "w" };
  const modKey = process.platform === "darwin" ? { meta: true } : { control: true };

  it("matches the platform's own modifier", () => {
    expect(matchElectronInput({ type: "keyDown", key: "w", ...modKey }, binding)).toBe(true);
  });

  it("ignores key-up", () => {
    expect(matchElectronInput({ type: "keyUp", key: "w", ...modKey }, binding)).toBe(false);
  });

  it("rejects a mismatched modifier set", () => {
    expect(matchElectronInput({ type: "keyDown", key: "w" }, binding)).toBe(false);
    expect(
      matchElectronInput({ type: "keyDown", key: "w", shift: true, ...modKey }, binding),
    ).toBe(false);
  });

  it("accepts the shifted spellings of bracket and backtick keys", () => {
    expect(
      matchElectronInput(
        { type: "keyDown", key: "}", ...modKey },
        { mod: true, shift: false, alt: false, key: "]" },
      ),
    ).toBe(true);
    expect(
      matchElectronInput(
        { type: "keyDown", key: "~", ...modKey },
        { mod: true, shift: false, alt: false, key: "`" },
      ),
    ).toBe(true);
  });
});
