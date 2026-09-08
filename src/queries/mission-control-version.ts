declare const __MC_VERSION__: string;

/**
 * The running build's version, injected at bundle time.
 *
 * This is all that remains of this module. It used to also serve a
 * latest-release query that answered "nothing to update to" without reaching
 * the network — a stub kept alive so the update surfaces would settle on
 * "you're on the latest version". Those surfaces are gone, and with them the
 * stub, the release type, and the query. The version itself stays: Settings and
 * the router both display it, and it is the app's only version readout.
 */
export const CURRENT_MC_VERSION: string =
  typeof __MC_VERSION__ !== "undefined" ? __MC_VERSION__ : "0.0.0";
