// Parsing the user's SSH config into the aliases it defines. Mission Control
// keeps no host list of its own, so this file is the only place a machine
// becomes visible — and the only thing read out of it is the alias. Hostnames,
// ports, and identity files stay ssh's business at connect time.

/**
 * Resolves an `Include` pattern to the contents of each file it names, in the
 * order OpenSSH would read them. Injected so the parser stays pure: the
 * filesystem, `~` expansion, and globbing all live on the caller's side.
 */
export type SshIncludeResolver = (pattern: string) => readonly string[];

// OpenSSH refuses to nest includes beyond 16 levels. Matching that bounds a
// config that includes itself, which the resolver alone cannot detect.
const MAX_INCLUDE_DEPTH = 16;

const KEYWORD_LINE = /^([A-Za-z][A-Za-z0-9_-]*)(?:\s*=\s*|\s+)(.*)$/;
const QUOTED_OR_BARE_ARG = /"([^"]*)"|(\S+)/g;
const WILDCARD = /[*?]/;

function splitArgs(rest: string): string[] {
  const args: string[] = [];
  QUOTED_OR_BARE_ARG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUOTED_OR_BARE_ARG.exec(rest)) !== null) args.push(match[1] ?? match[2]);
  return args;
}

/**
 * A pattern is a machine only if it names exactly one. A wildcard block is
 * defaults for many hosts and a negated pattern is an exclusion — neither is
 * something the user can connect to.
 */
function isConnectableAlias(pattern: string): boolean {
  return !!pattern && !pattern.startsWith("!") && !WILDCARD.test(pattern);
}

/** Host aliases the config defines, in file order, each listed once. */
export function parseSshHostAliases(text: string, resolveInclude?: SshIncludeResolver): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];

  const collect = (source: string, depth: number): void => {
    if (depth > MAX_INCLUDE_DEPTH) return;
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      // OpenSSH treats only a whole line as a comment, never a trailing `#`.
      if (!line || line.startsWith("#")) continue;
      const parsed = KEYWORD_LINE.exec(line);
      if (!parsed) continue;
      const keyword = parsed[1].toLowerCase();
      if (keyword === "host") {
        for (const pattern of splitArgs(parsed[2])) {
          if (!isConnectableAlias(pattern) || seen.has(pattern)) continue;
          seen.add(pattern);
          aliases.push(pattern);
        }
      } else if (keyword === "include" && resolveInclude) {
        for (const pattern of splitArgs(parsed[2])) {
          for (const included of resolveInclude(pattern)) collect(included, depth + 1);
        }
      }
    }
  };

  collect(text, 0);
  return aliases;
}
