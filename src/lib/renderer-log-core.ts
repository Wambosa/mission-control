/**
 * The decisions behind renderer event logging, with no transport attached.
 *
 * Split from renderer-log.ts because that module imports
 * `electron-log/renderer`, whose CommonJS tree the test bundler will not
 * resolve in a node environment. The same split the server-output forwarder
 * uses: injected dependencies here, the real transport wired in the shell.
 */

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

/**
 * The `{ event, ...ids }` shape R7 fixes, kept an object rather than a string.
 *
 * The name is written last so a field can never rename the event, and first in
 * insertion order so a truncated line still says what happened.
 */
export function rendererEventPayload(
  event: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = { event, ...fields };
  payload.event = event;
  return payload;
}

export function createRendererEventLogger(deps: RendererLogDeps): RendererEventLogger {
  return (event, fields = {}) => {
    if (!deps.bridgeReady()) return;
    try {
      deps.send(event, rendererEventPayload(event, fields));
    } catch {
      // Called from a router subscription, so a throw here would take
      // navigation down with it. A lost event must never break the interaction
      // that produced it.
    }
  };
}
