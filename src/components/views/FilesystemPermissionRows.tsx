import { Btn } from "~/components/ui/Btn";
import { Field, SettingsSection } from "~/components/views/SettingsParts";
import { useFsPermissions } from "~/queries/fs-permissions";
import { getElectron } from "~/lib/electron";
import {
  DECLARED_LOCATIONS,
  type FsPermissionOutcome,
  type FsPermissionRecord,
} from "~/shared/fs-permission";

/**
 * What the last check of each protected location found (R3, R21, R26), and the
 * jump to fix it (R15).
 *
 * Every label here is the outcome of an attempt, never a permission. macOS
 * exposes no API for the consent state of the file-access family, so a row that
 * said "granted" would be asserting something the app cannot know. Only a
 * privacy block offers the jump: an ordinary filesystem permission problem is
 * not grantable in the privacy pane, and sending the operator there for one
 * wastes their time.
 */

type OutcomeCopy = { label: string; tone: "ok" | "warn" | "dim"; detail: string };

const OUTCOMES: Record<FsPermissionOutcome, OutcomeCopy> = {
  readable: { label: "Readable", tone: "ok", detail: "The app listed this folder successfully." },
  "privacy-blocked": {
    label: "Blocked by macOS privacy",
    tone: "warn",
    detail: "macOS refused the listing. Grant access below, then reopen the session.",
  },
  "filesystem-blocked": {
    label: "Blocked by file permissions",
    tone: "warn",
    detail: "The filesystem refused the listing. This is not a privacy setting — check the folder's own permissions.",
  },
  absent: { label: "Not on this machine", tone: "dim", detail: "There is no such folder here." },
  unknowable: {
    label: "Nothing mounted",
    tone: "dim",
    detail: "No volume of this kind is mounted, and an unasked category cannot be told from a refused one.",
  },
  pending: {
    label: "Waiting on an answer",
    tone: "warn",
    detail: "A consent prompt may still be open. It can appear on another display or behind another app.",
  },
  "never-probed": { label: "Not checked", tone: "dim", detail: "No usable answer yet." },
};

const TONE_COLOR: Record<OutcomeCopy["tone"], string> = {
  ok: "var(--text)",
  warn: "var(--danger, #e5484d)",
  dim: "var(--text-dim)",
};

/**
 * How long ago the check was taken.
 *
 * The age is the point, not the timestamp. With ad-hoc signing a grant does not
 * survive a rebuild, so "readable, three days ago" and "readable, this launch"
 * are materially different claims and the row has to let the operator tell them
 * apart.
 */
function checkedAgo(checkedAt: number | null, now: number): string {
  if (checkedAt === null) return "never checked";
  const seconds = Math.max(0, Math.round((now - checkedAt) / 1000));
  if (seconds < 60) return "checked just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `checked ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `checked ${hours} h ago`;
  const days = Math.round(hours / 24);
  return `checked ${days} day${days === 1 ? "" : "s"} ago — from an earlier build`;
}

function PermissionRow({ record, now }: { record: FsPermissionRecord; now: number }) {
  const location = DECLARED_LOCATIONS.find((entry) => entry.category === record.category);
  const copy = OUTCOMES[record.outcome];
  if (!location) return null;

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        justifyContent: "space-between",
        flexWrap: "wrap",
        paddingBottom: 10,
        borderBottom: "1px solid var(--border, rgba(128,128,128,0.2))",
      }}
    >
      <div style={{ minWidth: 220, flex: "1 1 260px" }}>
        <div style={{ fontSize: 13, color: "var(--text)" }}>{location.label}</div>
        <div style={{ fontSize: 12, color: TONE_COLOR[copy.tone], marginTop: 2 }}>
          {copy.label} · <span style={{ color: "var(--text-dim)" }}>{checkedAgo(record.checkedAt, now)}</span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.45, marginTop: 2 }}>
          {copy.detail}
        </div>
      </div>
      {record.outcome === "privacy-blocked" && (
        <Btn
          type="button"
          variant="ghost"
          size="sm"
          icon="shield"
          onClick={() => void getElectron()?.fsPermissions?.openPrivacyPane(record.category)}
        >
          Open privacy settings
        </Btn>
      )}
    </div>
  );
}

export function FilesystemPermissionRows() {
  const snapshot = useFsPermissions();
  // Off macOS there is no consent model, so rows here could not mean anything.
  if (!snapshot?.supported) return null;

  const now = Date.now();
  return (
    <SettingsSection
      title="Folder access"
      subtitle="What the last check of each protected location found. macOS does not let an app read its own consent state, so these are attempts, not permissions."
    >
      <Field label="Protected locations">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {snapshot.records.map((record) => (
            <PermissionRow key={record.category} record={record} now={now} />
          ))}
          {!snapshot.resolved && (
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
              Still checking. A consent prompt may be waiting for an answer.
            </div>
          )}
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}>
            Access is granted to this exact build of the app. A locally-built app is re-signed every
            time it is rebuilt, so grants do not carry over and every location has to be granted
            again.
          </div>
        </div>
      </Field>
    </SettingsSection>
  );
}
