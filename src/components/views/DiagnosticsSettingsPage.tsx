import { useEffect, useId, useState } from "react";
import { Btn } from "~/components/ui/Btn";
import { CodeBlock, Field, SettingsSection, useCopy } from "~/components/views/SettingsParts";
import { getElectron } from "~/lib/electron";

/**
 * Diagnostics (R17-R20, R26, R27).
 *
 * Exports and reveals; it does not render the log. That is deliberate — an
 * in-app log viewer existed in this repo and was deleted along with its
 * server-side ring buffer, and logs persist to disk, so rebooting and then
 * exporting loses nothing.
 */
export function DiagnosticsSettingsPage() {
  const [logDir, setLogDir] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; message: string } | null>(null);
  const statusId = useId();
  const { copied, copy } = useCopy();

  useEffect(() => {
    const api = getElectron();
    if (!api?.diagnostics) return;
    let live = true;
    void api.diagnostics.logDirectory().then((dir) => {
      if (live) setLogDir(dir);
    });
    return () => {
      live = false;
    };
  }, []);

  const runExport = async () => {
    const api = getElectron();
    if (!api?.diagnostics) return;
    setStatus(null);
    setExporting(true);
    try {
      const result = await api.diagnostics.export();
      if (result.ok) {
        setStatus({ tone: "ok", message: `Saved to ${result.path}` });
      } else if (result.cancelled) {
        // A dismissed save dialog is not a failure and gets no error message.
        setStatus(null);
      } else {
        setStatus({ tone: "error", message: `Export failed: ${result.error}` });
      }
    } catch (err) {
      setStatus({ tone: "error", message: `Export failed: ${String(err)}` });
    } finally {
      setExporting(false);
    }
  };

  const revealLogs = async () => {
    const api = getElectron();
    if (!api?.diagnostics) return;
    setStatus(null);
    const result = await api.diagnostics.revealLogs();
    if (!result.ok) {
      setStatus({ tone: "error", message: `Couldn't open the log folder: ${result.error}` });
    }
  };

  const inElectron = Boolean(getElectron()?.diagnostics);

  return (
    <>
      <SettingsSection
        title="Diagnostics"
        subtitle="Collect what the app recorded about itself, to hand to whoever will act on it."
      >
        <Field label="Export">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Btn
                type="button"
                variant="solid"
                size="sm"
                icon="download"
                onClick={runExport}
                disabled={!inElectron || exporting}
                aria-busy={exporting}
                aria-describedby={statusId}
              >
                {exporting ? "Building bundle…" : "Export diagnostics"}
              </Btn>

              {/*
                R20. The scrubbed export is designed-for but not built: it is
                visible, cannot be activated, and carries the reason in its
                accessible name so it reads as reserved rather than broken.
                aria-disabled rather than `disabled` keeps it on the keyboard
                path, so a screen-reader user hears why instead of finding
                nothing there — the same treatment unavailable agents get in the
                project dialog.
              */}
              <Btn
                type="button"
                variant="ghost"
                size="sm"
                icon="shield"
                aria-disabled
                aria-label="Export scrubbed — not implemented yet; the raw export is the only one available"
                title="Not implemented yet — the raw export is the only one available"
                onClick={(event) => event.preventDefault()}
                style={{ opacity: 0.55, cursor: "not-allowed" }}
              >
                Export scrubbed
              </Btn>
            </div>

            <div
              id={statusId}
              role="status"
              aria-live="polite"
              aria-atomic="true"
              style={{
                fontSize: 12,
                lineHeight: 1.45,
                color: status?.tone === "error" ? "var(--danger, #e5484d)" : "var(--text-dim)",
                wordBreak: "break-all",
              }}
            >
              {status?.message ??
                (exporting
                  ? "Collecting logs and session transcripts…"
                  : inElectron
                    ? "Includes the app log, its rotated sibling, and retained session output."
                    : "Available in the desktop app.")}
            </div>

            <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}>
              The bundle is written so only your user account can read it, and it is{" "}
              <strong>not scrubbed</strong>: it carries local paths, project names, and verbatim
              terminal output, which can include file contents, environment dumps, and secrets that
              were printed. Read it before you share it.
            </div>
          </div>
        </Field>
      </SettingsSection>

      <SettingsSection title="Log folder" subtitle="Where the app writes its log and crash dumps.">
        <Field label="Location">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <CodeBlock
              value={logDir ?? (inElectron ? "…" : "Available in the desktop app.")}
              onCopy={logDir ? () => copy(logDir, "logdir") : undefined}
              copied={copied === "logdir"}
            />
            <div>
              <Btn
                type="button"
                variant="ghost"
                size="sm"
                icon="folder"
                onClick={revealLogs}
                disabled={!inElectron}
              >
                Reveal log folder
              </Btn>
            </div>
          </div>
        </Field>
      </SettingsSection>
    </>
  );
}
