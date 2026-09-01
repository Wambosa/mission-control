import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The default keymap is nearly empty, so what the store does with an operator's
// own bindings is the whole of its behavior: it must record them, return them
// merged over the (two) defaults, and forget them on reset — for every action
// in the registry, not just the ones that ship bound.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-keybindings-test-"));
process.env.MC_USER_DATA_DIR = tmpRoot;

const { getBindings, setBinding, resetBinding, resetAllBindings } = await import("../keybindings");
const { getDb } = await import("~/db/client");
const { appSettings } = await import("~/db/schema");

const CUSTOM = { mod: true, shift: true, alt: false, key: "j" };

beforeEach(() => {
  getDb().delete(appSettings).run();
});

describe("keybindings store", () => {
  it("ships only dialog submit and file save bound", () => {
    expect(Object.keys(getBindings()).sort()).toEqual(["dialog.submit", "file.save"]);
  });

  it("records a binding for an action that ships unbound", () => {
    setBinding("session.clone", CUSTOM);
    expect(getBindings()["session.clone"]).toEqual(CUSTOM);
  });

  it("keeps a stored binding across reads", () => {
    setBinding("terminal.toggle", CUSTOM);
    expect(getBindings()["terminal.toggle"]).toEqual(CUSTOM);
    expect(getBindings()["terminal.toggle"]).toEqual(CUSTOM);
  });

  it("keeps a custom binding for an action that does ship bound", () => {
    setBinding("file.save", CUSTOM);
    expect(getBindings()["file.save"]).toEqual(CUSTOM);
  });

  it("returns an action to unbound when its binding is reset", () => {
    setBinding("session.clone", CUSTOM);
    resetBinding("session.clone");
    expect(getBindings()["session.clone"]).toBeUndefined();
  });

  it("returns file save to its default rather than to unbound", () => {
    setBinding("file.save", CUSTOM);
    resetBinding("file.save");
    expect(getBindings()["file.save"]).toEqual({ mod: true, shift: false, alt: false, key: "s" });
  });

  it("resets everything back to the two defaults", () => {
    setBinding("session.clone", CUSTOM);
    setBinding("terminal.toggle", CUSTOM);
    expect(Object.keys(resetAllBindings()).sort()).toEqual(["dialog.submit", "file.save"]);
    expect(Object.keys(getBindings()).sort()).toEqual(["dialog.submit", "file.save"]);
  });
});
