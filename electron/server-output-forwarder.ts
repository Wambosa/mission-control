/**
 * Bundled-server stdout/stderr → main-process log file.
 *
 * The bundled server owns the API and the database, so its output is the only
 * record of what either did. Writing it to the parent's stdout/stderr threw it
 * away in a packaged build — those fds go nowhere when the app is launched from
 * Finder — so it goes to the log file instead, under a `[server]` prefix that
 * keeps it separable from main's own lines.
 *
 * This lives beside main.ts rather than inside it so the shutdown guard and the
 * swallow are reachable from a test; main.ts calls app.setPath() at module
 * scope and cannot be imported.
 */

export type ServerLogLevel = "info" | "error";

export type ServerOutputForwarderDeps = {
  /** Write one line to the log transport at this level. */
  write: (level: ServerLogLevel, line: string) => void;
  /**
   * Whether the app is shutting down. The guard predates this file — it used to
   * protect a stdio fd that had gone away (EIO) and now protects the transport,
   * which electron-log tears down on quit.
   */
  isQuitting: () => boolean;
};

export type ServerOutputForwarder = (level: ServerLogLevel, line: string) => void;

export function createServerOutputForwarder(
  deps: ServerOutputForwarderDeps,
): ServerOutputForwarder {
  return (level, line) => {
    if (deps.isQuitting()) return;
    try {
      deps.write(level, `[server] ${line}`);
    } catch {
      // A write can lose its race with shutdown even past the guard above.
      // Server output is diagnostic, so a lost line is strictly better than a
      // throw out of a readline handler taking the quit path with it.
      /* transport already torn down */
    }
  };
}
