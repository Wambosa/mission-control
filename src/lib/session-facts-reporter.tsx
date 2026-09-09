import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
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

/** The project whose panel is on screen, from the route. */
function useVisibleProjectId(): string | null {
  return useRouterState({
    select: (state) => {
      const match = /^\/projects\/([^/?#]+)/.exec(state.location.pathname);
      return match ? decodeURIComponent(match[1]) : null;
    },
  });
}

export function SessionFactsReporter() {
  const { sessions, activeFor } = useTerminals();
  const windowFocused = useWindowFocused();
  const visibleProjectId = useVisibleProjectId();

  /**
   * Exactly one session can be the one the operator is looking at.
   *
   * Asking each session whether it is its *own* project's active pane would
   * mark the active session of every open project as focused, which suppresses
   * an alert for every project the operator is not looking at — the feature's
   * primary case is several agents running while one is watched. Only the
   * active pane of the project on screen qualifies.
   *
   * Resolved to a plain id during render so it can drive the effect: it changes
   * when the operator switches panes, which the sessions array does not.
   */
  const focusedPtyId =
    windowFocused && visibleProjectId ? (activeFor(visibleProjectId)?.ptyId ?? null) : null;

  const lastSent = useRef<string>("");

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
        focused: session.ptyId === focusedPtyId,
      };
    }

    // Sent on change: a report identical to the last one tells the sweep
    // nothing, and this fires whenever any session's status moves.
    const serialized = JSON.stringify(report);
    if (serialized === lastSent.current) return;
    lastSent.current = serialized;
    void api.sessionFacts.report(report);
  }, [sessions, focusedPtyId]);

  return null;
}
