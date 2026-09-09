import { useEffect, useRef, useState } from "react";
import { getElectron } from "~/lib/electron";
import { useTerminals } from "~/lib/terminal-store";
import type { SessionFactsReport } from "~/shared/electron-contract";

/**
 * Push what the renderer knows about each session into the main process.
 *
 * The direction is deliberate and runs the opposite way from a fetch. Main owns
 * the timing and makes the silence decision — output timing is only observable
 * there, and the renderer loses all state on a reload the app binds a shortcut
 * to, which would reset every timer and re-arm every alert. Renderer timers are
 * throttled when hidden, intensively so after five minutes, which is precisely
 * the soft threshold.
 *
 * But main holds no session semantics, and the decision needs facts only the
 * renderer has. One of them has no other source at all: neither main nor the
 * server knows which pane the operator is looking at, so a fetch could never
 * satisfy the focused-session suppression rule.
 *
 * The repo already pushes this way — the renderer owns the battery-saver and
 * spellcheck settings and reports them into main, where the PTY pump consumes
 * them. This is the same shape with a map instead of a boolean.
 */

/** Whether this window currently has the operator's attention. */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() =>
    typeof document === "undefined" ? false : document.hasFocus(),
  );
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return focused;
}

export function SessionFactsReporter() {
  const { sessions, activeFor } = useTerminals();
  const windowFocused = useWindowFocused();
  const lastSent = useRef<string>("");

  // Built inside the effect rather than in a memo. `sessions` changes on hot
  // paths and `activeFor` is only as stable as the store's own state, so a memo
  // would rebuild and re-serialize this on renders that changed nothing about
  // it. Keyed on the two things that actually alter the report.
  useEffect(() => {
    const api = getElectron();
    if (!api?.sessionFacts) return;

    const report: SessionFactsReport = {};
    for (const session of sessions) {
      if (!session.ptyId) continue;
      report[session.ptyId] = {
        title: session.task.title,
        project: session.project.name ?? null,
        status: session.task.status,
        focused: windowFocused && activeFor(session.project.id)?.ptyId === session.ptyId,
      };
    }

    // Sent on change: a report identical to the last one tells the sweep
    // nothing, and this fires whenever any session's status moves.
    const serialized = JSON.stringify(report);
    if (serialized === lastSent.current) return;
    lastSent.current = serialized;
    void api.sessionFacts.report(report);
    // `activeFor` reads current store state; it is called here rather than
    // depended on, so its identity never drives a resend.
  }, [sessions, windowFocused]);

  return null;
}
