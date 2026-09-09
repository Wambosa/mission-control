import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Btn } from "~/components/ui/Btn";
import { Field, SettingsSection, ToggleRow } from "~/components/views/SettingsParts";
import { getElectron } from "~/lib/electron";
import { api, type AppSettings } from "~/lib/api";
import { queryKeys, useSettings } from "~/queries";
import { useSettingsWriter } from "~/lib/settings-mutation";
import { CURRENT_MC_VERSION } from "~/queries/mission-control-version";
import {
  readCachedLaunchIntroEnabled,
  writeCachedLaunchIntroEnabled,
} from "~/lib/launch-intro";
import {
  readOsNotificationPermission,
  requestOsNotificationPermission,
  type OsNotificationPermission,
} from "~/lib/os-notifications";
import { isElectron } from "~/lib/electron";

export function GeneralSettingsPage() {
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const mouseGradientEnabled = !(settings?.mouseGradientDisabled ?? false);
  const batterySaverEnabled = settings?.batterySaverEnabled ?? true;
  const spellcheckEnabled = settings?.spellcheckEnabled ?? true;
  const toastEnabled = settings?.sessionFinishToastEnabled ?? true;
  const osNotificationEnabled =
    settings?.sessionFinishOsNotificationEnabled ?? false;
  const notificationSoundEnabled = settings?.notificationSoundEnabled ?? true;
  const [launchOverlayEnabled, setLaunchOverlayEnabledState] = useState(
    () => readCachedLaunchIntroEnabled(),
  );
  const [permission, setPermission] = useState<OsNotificationPermission>("default");
  const [permissionHint, setPermissionHint] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      setPermission("unsupported");
      return;
    }
    const refreshPermission = () => {
      void readOsNotificationPermission().then(setPermission);
    };
    refreshPermission();
    window.addEventListener("focus", refreshPermission);
    return () => window.removeEventListener("focus", refreshPermission);
  }, []);

  useEffect(() => {
    if (typeof settings?.launchOverlayEnabled !== "boolean") return;
    setLaunchOverlayEnabledState(settings.launchOverlayEnabled);
    writeCachedLaunchIntroEnabled(settings.launchOverlayEnabled);
  }, [settings?.launchOverlayEnabled]);

  const writeSetting = useSettingsWriter();

  const updateSettings = async (
    patch: Partial<
      Pick<
        AppSettings,
        | "agentSystemBannerDisabled"
        | "mouseGradientDisabled"
        | "batterySaverEnabled"
        | "spellcheckEnabled"
        | "sessionFinishToastEnabled"
        | "sessionFinishOsNotificationEnabled"
        | "notificationSoundEnabled"
        | "launchOverlayEnabled"
      >
    >,
  ) => {
    await writeSetting(patch);
  };

  const setMouseGradientEnabled = async (enabled: boolean) => {
    await updateSettings({ mouseGradientDisabled: !enabled });
  };

  const setBatterySaverEnabled = async (enabled: boolean) => {
    await updateSettings({ batterySaverEnabled: enabled });
  };

  const setSpellcheckEnabled = async (enabled: boolean) => {
    await updateSettings({ spellcheckEnabled: enabled });
    // Apply live in the running Electron session (no-op in the browser).
    void getElectron()?.spellcheck?.setEnabled(enabled);
  };

  const setToastEnabled = async (sessionFinishToastEnabled: boolean) => {
    await updateSettings({ sessionFinishToastEnabled });
  };

  const setNotificationSoundEnabled = async (enabled: boolean) => {
    await updateSettings({ notificationSoundEnabled: enabled });
  };

  const setLaunchOverlayEnabled = (enabled: boolean) => {
    setLaunchOverlayEnabledState(enabled);
    writeCachedLaunchIntroEnabled(enabled);
    queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) =>
      current ? { ...current, launchOverlayEnabled: enabled } : current,
    );
    void api
      .updateSettings({ launchOverlayEnabled: enabled })
      .then((next) => {
        queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) => ({
          ...(current ?? ({} as AppSettings)),
          ...next,
          launchOverlayEnabled: enabled,
        }));
      })
      .catch((error) => {
        console.error("[settings] failed to sync launch intro preference:", error);
        queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) =>
          current ? { ...current, launchOverlayEnabled: enabled } : current,
        );
      });
  };

  const setOsNotificationEnabled = async (enabled: boolean) => {
    setPermissionHint(null);
    if (enabled) {
      const current = await readOsNotificationPermission();
      setPermission(current);
      if (current === "unsupported") {
        setPermissionHint("OS notifications are not supported in this environment.");
        return;
      }
      if (!isElectron()) {
        if (current === "denied") {
          setPermissionHint(
            "Notification permission is blocked. Enable it in your OS or browser settings, then try again.",
          );
          return;
        }
        if (current === "default") {
          const result = await requestOsNotificationPermission();
          setPermission(result);
          if (result !== "granted") {
            setPermissionHint(
              "Notification permission was not granted. Enable it in your OS or browser settings, then try again.",
            );
            return;
          }
        }
      }
    }
    await updateSettings({
      sessionFinishOsNotificationEnabled: enabled,
    });
  };

  const osNotificationBlocked =
    osNotificationEnabled &&
    permission !== "unsupported" &&
    permission !== "granted";
  const osNotificationStatusMessage =
    permissionHint ??
    (osNotificationBlocked && permission === "denied" && !isElectron()
      ? "Notification permission is blocked. On macOS, open System Settings → Notifications → Mission Control, allow notifications, then reload Mission Control."
      : osNotificationBlocked && permission === "default" && !isElectron()
        ? "Notification permission is not granted yet. Turn this toggle off and on again to approve the prompt."
        : null);

  return (
    <>
      <SettingsSection
        title="General"
        subtitle="Control app-wide interface preferences."
        headingLevel="h1"
      >
        {/* AgentSystem.dev banner toggle hidden for now — the banner itself
            is also gated off in __root.tsx. */}
        <Field label="Mouse gradient">
          <ToggleRow
            title="Show mouse gradient"
            description="Cursor and card gradients follow the pointer across the workspace."
            checked={mouseGradientEnabled}
            onChange={setMouseGradientEnabled}
            label="Enable"
          />
        </Field>
        <Field label="Battery saver">
          <ToggleRow
            title="Reduce energy use on battery"
            description="On battery power, decorative animations freeze, terminal cursors stop blinking, and idle refresh slows down."
            checked={batterySaverEnabled}
            onChange={setBatterySaverEnabled}
            label="Enable"
          />
        </Field>
        <Field label="Spellcheck">
          <ToggleRow
            title="Spellcheck in text fields"
            description="Underline misspelled words as you type in prompts and inputs. Turning this off frees roughly 15-20 MB of memory while composing."
            checked={spellcheckEnabled}
            onChange={setSpellcheckEnabled}
            label="Enable"
          />
        </Field>
        <Field label="Startup loading screen">
          <ToggleRow
            title="Show launch intro"
            description="Sliding doors, voice, and sound effects play the next time Mission Control loads."
            checked={launchOverlayEnabled}
            onChange={setLaunchOverlayEnabled}
            label="Enable"
          />
        </Field>
      </SettingsSection>
      <SettingsSection
        title="Session finish notifications"
        subtitle="Get notified when a Claude session finishes in any project."
      >
        <Field label="Sound">
          <ToggleRow
            title="Notification sound"
            description="Play a short ding when a session finishes or a diagram is ready."
            checked={notificationSoundEnabled}
            onChange={setNotificationSoundEnabled}
            label="Play sound"
          />
        </Field>
        <Field label="Toast">
          <ToggleRow
            title="Show toast"
            description="A toast appears in the bottom-right when a session finishes."
            checked={toastEnabled}
            onChange={setToastEnabled}
            label="Show toast"
          />
        </Field>
        <Field label="OS notification">
          <ToggleRow
            title="OS notification"
            description={
              permission === "unsupported"
                ? "Not supported in this environment."
                : isElectron()
                  ? "Uses macOS notifications through Electron. Control badges, sounds, and banners in System Settings → Notifications → Electron."
                  : "A native OS notification appears so you see it even when the app is in the background."
            }
            checked={osNotificationEnabled}
            onChange={setOsNotificationEnabled}
            disabled={permission === "unsupported"}
            label="Enable"
          />
          {osNotificationStatusMessage && (
            <div
              role="status"
              style={{
                marginTop: 8,
                fontSize: 12,
                color: "var(--text-dim)",
                lineHeight: 1.45,
              }}
            >
              {osNotificationStatusMessage}
            </div>
          )}
        </Field>
      </SettingsSection>
      <AboutSection />
      <ReloadSection />
    </>
  );
}

function AboutSection() {
  // Version display only. This section used to interleave update check,
  // download and install UI with the app's only version readout — and this
  // fork ships no release feed, so all of that was dead weight around the one
  // line worth keeping. There is no native about panel to fall back on
  // (setAboutPanelOptions is called nowhere), so this stays the app's single
  // place to read the running version.
  return (
    <SettingsSection title="About" subtitle="Version information for Mission Control.">
      <Field label="Version">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "12px 14px",
            background: "var(--surface-0)",
            border: "1px solid var(--border)",
            borderRadius: 7,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
            Installed: v{CURRENT_MC_VERSION}
          </div>
        </div>
      </Field>
    </SettingsSection>
  );
}

function ReloadSection() {
  const reload = () => {
    const electron = getElectron();
    if (electron) {
      void electron.reload();
      return;
    }
    if (typeof window === "undefined") return;
    window.location.reload();
  };

  return (
    <SettingsSection title="Reload" subtitle="Refresh the current Mission Control window.">
      <Field label="Window">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            padding: "12px 14px",
            background: "var(--surface-0)",
            border: "1px solid var(--border)",
            borderRadius: 7,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>
              Reload app
            </div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}>
              Applies fresh frontend code and reconnects to the local server.
            </div>
          </div>
          <Btn type="button" variant="solid" size="sm" icon="refresh" onClick={reload}>
            Reload
          </Btn>
        </div>
      </Field>
    </SettingsSection>
  );
}
