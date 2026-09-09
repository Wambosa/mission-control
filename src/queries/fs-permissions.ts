import { useEffect, useState } from "react";
import { getElectron } from "~/lib/electron";
import type { FsPermissionsSnapshot } from "~/shared/electron-contract";

/**
 * The protected-location probe outcomes, read once and then kept live by the
 * launch sweep's pushes.
 *
 * Deliberately not a TanStack query: these are per-launch runtime facts owned
 * by the main process, not stored settings served over HTTP. The read is the
 * starting point and the push is the update — polling would show a
 * half-finished sweep as though it were finished.
 */
export function useFsPermissions(): FsPermissionsSnapshot | null {
  const [snapshot, setSnapshot] = useState<FsPermissionsSnapshot | null>(null);

  useEffect(() => {
    const api = getElectron();
    if (!api?.fsPermissions) return;

    let live = true;
    void api.fsPermissions.get().then((next) => {
      if (live) setSnapshot(next);
    });

    const unsubscribe = api.fsPermissions.onChanged((update) => {
      if (!live) return;
      // `supported` is a property of the platform, not of the sweep, so it
      // comes from the read. A push that arrives first is dropped rather than
      // guessed at — claiming support the platform may not have would render
      // rows that cannot mean anything.
      setSnapshot((current) =>
        current ? { ...current, records: update.records, resolved: update.resolved } : current,
      );
    });

    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return snapshot;
}
