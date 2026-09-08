/**
 * Structured events from the renderer, into the app log file.
 *
 * Uses electron-log's own renderer transport rather than a purpose-built IPC
 * channel: the transport is already available once the logger is initialized in
 * main, and it preserves the `{ event, ...ids }` object shape instead of
 * flattening it to a string the way the console hook does. The console hook
 * still earns its place — it captures the existing raw `console.*` sites
 * unchanged — but a structured event deserves to arrive structured.
 *
 * Call sites go through this module rather than importing the transport
 * directly, so the availability guard and the double-write suppression live in
 * one place. The decisions themselves are in renderer-log-core.ts, which is
 * where they can be tested; this file is the wiring.
 */

import log from "electron-log/renderer";
import { createRendererEventLogger } from "./renderer-log-core";

/**
 * electron-log's renderer logger also owns a console transport. Left on, every
 * event would print to the renderer console as well — where main's
 * `console-message` hook would pick it up and write it to the same file a
 * second time, in a different shape. Raw `console.*` calls in app code are
 * unaffected; this only silences electron-log's own echo.
 */
log.transports.console.level = false;

/** Emit one structured renderer event, or nothing at all outside Electron. */
export const logRendererEvent = createRendererEventLogger({
  send: (event, payload) => log.info(event, payload),
  // The bare global the transport itself dereferences — the same object as
  // `window.__electronLog` in a renderer, but testing the one that is actually
  // read is what makes the guard honest.
  bridgeReady: () => Boolean((globalThis as { __electronLog?: unknown }).__electronLog),
});
