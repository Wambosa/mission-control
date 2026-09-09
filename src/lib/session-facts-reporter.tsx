import { useEffect, useMemo, useRef, useState } from "react";
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

  const report = useMemo<SessionFactsReport>(() => {
    const out: SessionFactsReport = {};
    for (const session of sessions) {
      if (!session.ptyId) continue;
      const active = activeFor(session.project.id);
      out[session.ptyId] = {
        title: session.task.title,
        project: session.project.name ?? null,
        status: session.task.status,
        focused: windowFocused && active?.ptyId === session.ptyId,
      };
    }
    return out;
  }, [sessions, activeFor, windowFocused]);

  useEffect(() => {
    const api = getElectron();
    if (!api?.sessionFacts) return;
    // Sent on change rather than on a tick: the sweep reads the last report it
    // was given, and a report that has not changed tells it nothing new.
    const serialized = JSON.stringify(report);
    if (serialized === lastSent.current) return;
    lastSent.current = serialized;
    void api.sessionFacts.report(report);
  }, [report]);

  return null;
}
