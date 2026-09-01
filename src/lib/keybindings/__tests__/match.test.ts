import { describe, it, expect } from "vitest";
import {
  matchBinding,
  matchOptionalBinding,
  eventToBinding,
  bindingComboKey,
  bindingsEqual,
  isValidBinding,
  matchPinnedSlotBinding,
  matchAnyPinnedSlot,
} from "../match";
import { DEFAULT_BINDINGS } from "../defaults";
import { HOTKEY_ACTIONS, type Binding, type HotkeyAction } from "../types";

function ev(init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }): KeyboardEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  } as unknown as KeyboardEvent;
}

describe("the default keymap", () => {
  // Nothing fires out of the box but the two a form is expected to honor.
  // Every other action stays bindable; it just starts unbound.
  it("binds only dialog submit and file save", () => {
    expect(Object.keys(DEFAULT_BINDINGS).sort()).toEqual(["dialog.submit", "file.save"]);
  });

  it("leaves every other action unbound rather than dropping it from the registry", () => {
    for (const action of HOTKEY_ACTIONS) {
      if (action === "dialog.submit" || action === "file.save") continue;
      expect(DEFAULT_BINDINGS[action]).toBeUndefined();
    }
    expect(HOTKEY_ACTIONS.length).toBeGreaterThan(2);
  });

  it("keeps no binding for a capability that no longer exists", () => {
    expect(HOTKEY_ACTIONS as readonly string[]).not.toContain("voice.pushToTalk");
  });
});

describe("matchOptionalBinding", () => {
  // AE8: with default settings, a chord that used to do something does nothing.
  it("fires nothing for an unbound action", () => {
    for (const action of ["session.clone", "terminal.toggle", "git.diff"] as const) {
      expect(matchOptionalBinding(ev({ metaKey: true, key: "d" }), DEFAULT_BINDINGS[action])).toBe(
        false,
      );
    }
  });

  it("does not throw on a keydown against an empty binding map", () => {
    const empty = {} as Partial<Record<HotkeyAction, Binding>>;
    expect(() => matchOptionalBinding(ev({ metaKey: true, key: "k" }), empty["terminal.clear"])).not.toThrow();
    expect(matchOptionalBinding(ev({ metaKey: true, key: "k" }), empty["terminal.clear"])).toBe(false);
  });

  it("still fires an action the operator bound themselves", () => {
    const custom: Binding = { mod: true, shift: true, alt: false, key: "j" };
    expect(matchOptionalBinding(ev({ metaKey: true, shiftKey: true, key: "j" }), custom)).toBe(true);
  });

  it("fires the two bindings that ship bound", () => {
    expect(
      matchOptionalBinding(ev({ metaKey: true, key: "Enter" }), DEFAULT_BINDINGS["dialog.submit"]),
    ).toBe(true);
    expect(matchOptionalBinding(ev({ metaKey: true, key: "s" }), DEFAULT_BINDINGS["file.save"])).toBe(
      true,
    );
  });
});

describe("matchBinding", () => {
  it("matches every bound default against an event built from it", () => {
    for (const action of HOTKEY_ACTIONS) {
      const b = DEFAULT_BINDINGS[action];
      if (!b) continue;
      const e = ev({ metaKey: b.mod, shiftKey: b.shift, altKey: b.alt, key: b.key });
      expect(matchBinding(e, b)).toBe(true);
    }
  });

  it("rejects when modifiers differ", () => {
    const b = DEFAULT_BINDINGS["file.save"]!;
    expect(matchBinding(ev({ key: b.key }), b)).toBe(false);
  });

  it("treats Shift+~ as a match for `", () => {
    expect(
      matchBinding(ev({ metaKey: true, shiftKey: false, key: "~" }), { mod: true, shift: false, alt: false, key: "`" }),
    ).toBe(true);
  });

  it("treats Shift+} as a match for ] with shift", () => {
    expect(
      matchBinding(ev({ metaKey: true, shiftKey: true, key: "}" }), { mod: true, shift: true, alt: false, key: "]" }),
    ).toBe(true);
  });

  it("matches pinned slots that share modifiers with the slot-1 binding", () => {
    const base = { mod: true, shift: false, alt: false, key: "1" };
    expect(matchPinnedSlotBinding(ev({ metaKey: true, key: "3" }), base, 3)).toBe(true);
    expect(matchAnyPinnedSlot(ev({ metaKey: true, key: "2" }), base)).toBe(2);
  });

  it("is case-insensitive for letter keys", () => {
    const b = { mod: true, shift: false, alt: false, key: "n" };
    expect(matchBinding(ev({ metaKey: true, key: "N" }), b)).toBe(true);
  });
});

describe("eventToBinding", () => {
  it("ignores lone modifier keys", () => {
    expect(eventToBinding(ev({ key: "Meta", metaKey: true }))).toBeNull();
  });

  it("captures Cmd+Shift+P", () => {
    const b = eventToBinding(ev({ metaKey: true, shiftKey: true, key: "P" }));
    expect(b).toEqual({ mod: true, shift: true, alt: false, key: "p" });
  });
});

describe("isValidBinding", () => {
  it("requires Cmd/Ctrl", () => {
    expect(isValidBinding({ mod: false, shift: false, alt: false, key: "n" }).ok).toBe(false);
  });
  it("accepts a valid mod+key", () => {
    expect(isValidBinding({ mod: true, shift: false, alt: false, key: "n" }).ok).toBe(true);
  });
});

describe("bindingComboKey + bindingsEqual", () => {
  it("treats the same combo as equal regardless of key casing", () => {
    const a = { mod: true, shift: false, alt: false, key: "N" };
    const b = { mod: true, shift: false, alt: false, key: "n" };
    expect(bindingComboKey(a)).toBe(bindingComboKey(b));
    expect(bindingsEqual(a, b)).toBe(true);
  });
});
