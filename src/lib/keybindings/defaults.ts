import type { Binding, BindingMap } from "./types";

export function makeBinding(partial: Partial<Binding> & { key: string }): Binding {
  return { mod: false, shift: false, alt: false, ...partial };
}

/**
 * What is bound out of the box: almost nothing.
 *
 * A chord that fires without being asked for is a claim on a key the terminal
 * might want, and the coding agent below is where the work happens. Every
 * action stays in the registry and on the settings page, so any of them can be
 * bound — the map only says which ones start that way.
 *
 * The two that remain are the ones a form is expected to honor: submitting the
 * dialog you are typing in, and saving the file you are editing. Neither
 * competes with the terminal, because neither fires while it has focus.
 *
 * This is not the terminal's own keymap. `src/lib/terminal-keymap.ts` is a
 * separate layer carrying the editing keys the operator relies on, and it is
 * deliberately untouched by this.
 */
export const DEFAULT_BINDINGS: BindingMap = {
  "dialog.submit": makeBinding({ mod: true, key: "Enter" }),
  "file.save": makeBinding({ mod: true, key: "s" }),
};
