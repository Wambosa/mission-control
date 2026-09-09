import { useCallback } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, type AppSettings } from "~/lib/api";
import { queryKeys } from "~/queries";

/** The key subset `POST /api/settings` accepts, kept in sync with the client. */
export type SettingsPatch = Parameters<typeof api.updateSettings>[0];

export type SettingsWriteOptions = {
  /**
   * Fields the caller derives from the patch and wants reflected in the cache
   * immediately, but does not send to the server — e.g. `minimalTheme`, which
   * the server recomputes from `themeStyle`.
   */
  derived?: Partial<AppSettings>;
  /**
   * Called with the restored settings when the write fails, so a DOM side
   * effect applied before the write (accent color, wallpaper, font) rewinds
   * together with the cache. Not called when there was nothing cached to
   * restore.
   */
  rollback?: (restored: AppSettings) => void;
};

/**
 * Write a settings patch with an optimistic cache update and rollback.
 *
 * Every settings surface used to hand-roll this: snapshot the cache, write an
 * optimistic value, POST, merge the response, and restore the snapshot on
 * failure. Thirteen components duplicated it and three of them also rebuilt the
 * whole `AppSettings` default set to do so.
 *
 * The server returns the complete settings payload, so the post-success merge
 * is belt-and-braces rather than load-bearing. When the cache is empty there is
 * nothing to roll back to, so the optimistic write is skipped and the server
 * response seeds the cache directly — safer than publishing a partial
 * `AppSettings` that readers would see as missing fields.
 */
export async function writeSettings(
  queryClient: QueryClient,
  patch: SettingsPatch,
  options: SettingsWriteOptions = {},
): Promise<AppSettings> {
  const previous = queryClient.getQueryData<AppSettings>(queryKeys.settings);
  const optimistic = previous
    ? ({ ...previous, ...options.derived, ...patch } as AppSettings)
    : undefined;
  if (optimistic) queryClient.setQueryData(queryKeys.settings, optimistic);

  try {
    const updated = await api.updateSettings(patch);
    const merged = optimistic ? { ...optimistic, ...updated } : updated;
    queryClient.setQueryData(queryKeys.settings, merged);
    return merged;
  } catch (error) {
    if (previous) {
      queryClient.setQueryData(queryKeys.settings, previous);
      options.rollback?.(previous);
    }
    throw error;
  }
}

/** Hook form of {@link writeSettings}, bound to the active query client. */
export function useSettingsWriter() {
  const queryClient = useQueryClient();
  return useCallback(
    (patch: SettingsPatch, options?: SettingsWriteOptions) =>
      writeSettings(queryClient, patch, options),
    [queryClient],
  );
}
