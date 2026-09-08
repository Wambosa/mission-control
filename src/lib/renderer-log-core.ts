/**
 * The decisions behind renderer event logging, with no transport attached.
 *
 * Split from renderer-log.ts because that module imports
 * `electron-log/renderer`, whose CommonJS tree the test bundler will not
 * resolve in a node environment. The same split the server-output forwarder
 * uses: injected dependencies here, the real transport wired in the shell.
 *
 * The payload shape itself is shared with the server emitter — see
 * ~/shared/log-event-shape.
 */

import { eventPayload } from "~/shared/log-event-shape";

export type RendererLogDeps = {
  /** Hand one structured event to the transport. */
  send: (event: string, payload: Record<string, unknown>) => void;
  /**
   * Whether the main-process bridge exists yet.
   *
   * The renderer also runs under `vite` in development, where there is no main
   * process to receive an IPC message, and electron-log's own fallback for that
   * is to print an error to the console per call — worse than silence.
   *
   * A function rather than a boolean: the injected global arrives with the
   * preload script, so an answer captured at module-evaluation time would be a
   * permanent false.
   */
  bridgeReady: () => boolean;
};

export type RendererEventLogger = (
  event: string,
  fields?: Record<string, unknown>,
) => void;

export function createRendererEventLogger(deps: RendererLogDeps): RendererEventLogger {
  return (event, fields = {}) => {
    if (!deps.bridgeReady()) return;
    try {
      deps.send(event, eventPayload(event, fields));
    } catch {
      // Called from a router subscription, so a throw here would take
      // navigation down with it. A lost event must never break the interaction
      // that produced it.
    }
  };
}
