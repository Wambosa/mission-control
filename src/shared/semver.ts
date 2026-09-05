/** Strip a leading `v`/`V` prefix from a version string (e.g. release tags). */
function stripVersionPrefix(version: string): string {
  return version.trim().replace(/^v/i, "");
}

/** Core numeric segment before any `-` prerelease or `+` build suffix. */
export function versionCore(version: string): string {
  return stripVersionPrefix(version).split(/[-+]/)[0];
}
