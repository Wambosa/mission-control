/**
 * Renderer `console.*` → main-process log file.
 *
 * The renderer had no file transport at all, so a UI failure left nothing on
 * disk and the only way to see one was to reproduce it live with DevTools open
 * — which is what TERMINAL_FOCUS_BUG.md's diagnostic plan was reduced to.
 *
 * electron-log's own `spyRendererConsole` option would also work today, but it
 * reads the `(event, level, message)` positional arguments Electron marks
 * @deprecated on `console-message`; the `details` object is the supported shape
 * and survives their removal. It also carries the source location and the
 * originating frame, which the positional form only exposes as a bare id.
 *
 * This lives beside main.ts rather than inside it so the level mapping and the
 * frame labelling are reachable from a test — main.ts calls app.setPath() at
 * module scope and cannot be imported.
 */

/** The shape this module needs from `WebContentsConsoleMessageEventParams`. */
export type RendererConsoleDetails = {
  message: string;
  /**
   * A string here ('debug' | 'info' | 'warning' | 'error') — not the 0-3 integer
   * the deprecated positional argument carries. Indexing one with the other
   * silently yields nothing, which is why this is read by its documented name.
   */
  level: "debug" | "info" | "warning" | "error";
  lineNumber: number;
  sourceId: string;
  frame?: RendererFrame | null;
};

/** The shape this module needs from `WebFrameMain`. */
export type RendererFrame = {
  detached: boolean;
  parent: unknown;
  routingId: number;
};

/**
 * electron-log method per renderer severity. 'debug' maps to the transport's
 * `debug` method and is then dropped by the file transport's "info" threshold,
 * which is intended — renderer debug output is dev-time noise.
 */
const RENDERER_LOG_METHOD = {
  debug: "debug",
  info: "info",
  warning: "warn",
  error: "error",
} as const;

export type RendererLogMethod = (typeof RENDERER_LOG_METHOD)[keyof typeof RENDERER_LOG_METHOD];

export function rendererLogMethod(level: RendererConsoleDetails["level"]): RendererLogMethod {
  // Unknown severities land at "info" rather than being dropped: a level this
  // map has not seen yet is still a line someone printed on purpose.
  return RENDERER_LOG_METHOD[level] ?? "info";
}

/**
 * Which frame produced the line. `console-message` fires for every frame in the
 * WebContents, not only the top document, so an unlabelled line from a subframe
 * reads as the app's own and sends the reader to the wrong code.
 */
export function rendererFrameLabel(frame: RendererFrame | null | undefined): string {
  if (!frame) return "?";
  try {
    // A console line can outlive the frame that emitted it, and every other
    // WebFrameMain property throws once the frame is detached — so this check
    // comes before any of them, and the catch covers the race where the frame
    // goes away between the two reads.
    if (frame.detached) return "detached";
    return frame.parent ? `subframe#${frame.routingId}` : "top";
  } catch {
    return "gone";
  }
}

/** The log line for one renderer console message, frame and source included. */
export function formatRendererConsoleLine(details: RendererConsoleDetails): string {
  const origin = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : "";
  return `[renderer:${rendererFrameLabel(details.frame)}] ${details.message}${origin}`;
}
