import { queryOptions, useQuery } from "@tanstack/react-query";

declare const __MC_VERSION__: string;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const CURRENT_MC_VERSION: string =
  typeof __MC_VERSION__ !== "undefined" ? __MC_VERSION__ : "0.0.0";

type LatestRelease = {
  latestVersion: string | null;
  downloadUrl: string;
  isUpdateAvailable: boolean;
};

// This fork publishes no releases and diverges from upstream deliberately, so
// upstream's latest version is not a newer version of this build — offering it
// would hand the operator a one-click path back to the product this forked away
// from. Answer "nothing to update to" without reaching the network; the update
// surfaces read this and settle on "you're on the latest version". An empty
// downloadUrl is what those surfaces already treat as "no manual download".
const NO_RELEASE_CHANNEL: LatestRelease = {
  latestVersion: CURRENT_MC_VERSION,
  downloadUrl: "",
  isUpdateAvailable: false,
};

export const latestMissionControlVersionQueryOptions = queryOptions({
  queryKey: ["mission-control", "latest-version"] as const,
  queryFn: () => NO_RELEASE_CHANNEL,
  staleTime: Infinity,
  gcTime: MS_PER_DAY,
  retry: false,
  refetchOnWindowFocus: false,
});

export const useLatestMissionControlVersion = () =>
  useQuery(latestMissionControlVersionQueryOptions);
