import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseSshHostAliases } from "../src/shared/ssh-config";

// The filesystem half of SSH host discovery: locate the user's config, follow
// its includes the way OpenSSH would, and hand the text to the pure parser.
// Nothing here writes — the SSH config belongs to the user.

const WILDCARD = /[*?]/;

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    // Absent, a directory, or unreadable — all mean "no hosts from here".
    return null;
  }
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

/**
 * Expand one `Include` pattern to concrete paths. Relative patterns resolve
 * against `~/.ssh`, as OpenSSH does for a user config. Only the final segment
 * may glob, which covers the `conf.d/*.conf` shape people actually write.
 */
function resolveIncludePaths(pattern: string, sshDir: string, homeDir: string): string[] {
  const expanded = pattern.startsWith("~/") ? path.join(homeDir, pattern.slice(2)) : pattern;
  const absolute = path.isAbsolute(expanded) ? expanded : path.join(sshDir, expanded);
  const base = path.basename(absolute);
  if (!WILDCARD.test(base)) return [absolute];

  const dir = path.dirname(absolute);
  if (WILDCARD.test(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const matches = globToRegExp(base);
  return entries
    .filter((entry) => entry.isFile() && matches.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/** Host aliases from the user's SSH config, in file order. Empty when absent. */
export function readSshHostAliases(homeDir: string = os.homedir()): string[] {
  const sshDir = path.join(homeDir, ".ssh");
  const text = readTextFile(path.join(sshDir, "config"));
  if (text === null) return [];
  return parseSshHostAliases(text, (pattern) =>
    resolveIncludePaths(pattern, sshDir, homeDir)
      .map(readTextFile)
      .filter((contents): contents is string => contents !== null),
  );
}
