import { useEffect } from "react";
import { toast } from "sonner";
import { Btn } from "~/components/ui/Btn";
import { getElectron } from "~/lib/electron";
import { MC_TOAST_OPTS } from "~/lib/mc-toast";
import type { SilenceAlertPayload, SilenceAlertSession } from "~/shared/electron-contract";

/**
 * Surface a silent session in the app (R9, R11, R13).
 *
 * In-app rather than a platform notification, deliberately: the notification
 * class requires a code-signed app from the next Electron major onward and this
 * fork signs ad-hoc. The dock signal that survives the operator being away uses
 * a different mechanism and lives in main.
 *
 * An in-app surface has no two-line clamp, so the tail renders as the several
 * lines it usually is — which is the point of carrying it. The tail is what
 * turns "this looks stuck" into a diagnosis, and it is usually the blocking
 * path in plain text.
 */

function formatSilence(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function sessionLabel(session: SilenceAlertSession): string {
  return session.project ? `${session.project} · ${session.title}` : session.title;
}

function SilenceToastBody({ payload }: { payload: SilenceAlertPayload }) {
  const first = payload.sessions[0];
  const heading = payload.coalesced
    ? `${payload.sessions.length} sessions have gone quiet`
    : `${sessionLabel(first)} has been silent for ${formatSilence(first.silentMs)}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <div style={{ fontSize: 13, color: "var(--text)" }}>{heading}</div>

      {payload.coalesced ? (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "var(--text-dim)" }}>
          {payload.sessions.map((session) => (
            <li key={session.ptyId}>
              {sessionLabel(session)} — {formatSilence(session.silentMs)}
            </li>
          ))}
        </ul>
      ) : (
        <>
          {first.awaitingOperator && (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              Nothing has come back since you last typed into it.
            </div>
          )}
          {first.remediation && (
            <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.45 }}>
              {first.remediation}
            </div>
          )}
          {first.tail && (
            <pre
              style={{
                margin: 0,
                maxHeight: 160,
                overflow: "auto",
                fontFamily: "var(--mono)",
                fontSize: 11,
                lineHeight: 1.45,
                color: "var(--text-dim)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {first.tail}
            </pre>
          )}
          {first.privacyCategory && (
            <div>
              <Btn
                type="button"
                variant="ghost"
                size="sm"
                icon="shield"
                onClick={() =>
                  void getElectron()?.fsPermissions?.openPrivacyPane(first.privacyCategory!)
                }
              >
                Open privacy settings
              </Btn>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function useSilenceNotifications(): void {
  useEffect(() => {
    const api = getElectron();
    if (!api?.sessionSilence) return;
    return api.sessionSilence.onAlert((payload) => {
      if (payload.sessions.length === 0) return;
      toast(<SilenceToastBody payload={payload} />, {
        ...MC_TOAST_OPTS,
        // A hard-threshold alert is the one that also holds the dock, so it
        // stays until dismissed rather than expiring while nobody is there.
        duration: payload.stage === "hard" ? Infinity : 30_000,
        id: `session-silence-${payload.stage}-${payload.sessions.map((s) => s.ptyId).join(",")}`,
      });
    });
  }, []);
}
