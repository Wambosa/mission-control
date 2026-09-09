/**
 * Expand a leading `~` to the user's home directory.
 *
 * A path typed or pasted by a person routinely starts with `~`, and every
 * filesystem call in Node treats it as an ordinary directory name — so
 * `~/Documents` becomes a lookup for a folder literally called `~` and fails
 * as "not found", which is a true answer to the wrong question.
 *
 * Applied in the main process rather than trusted from the renderer: several
 * renderer surfaces can supply a path and only one of them remembered to
 * expand it, which is exactly the kind of gap that reappears with the next
 * caller.
 */

/** Only a bare `~`, or `~` followed by a separator, is the current user's home. */
export function expandTilde(input: string, home: string): string {
  if (!input.startsWith("~")) return input;
  if (input === "~") return home;

  const next = input[1];
  // `~alice/x` names another user's home, which cannot be resolved from here.
  // Leaving it alone lets it fail honestly rather than silently becoming this
  // user's home plus a stray path segment.
  if (next !== "/" && next !== "\\") return input;

  const rest = input.slice(2);
  if (!rest) return home;
  return `${home.replace(/[/\\]+$/, "")}/${rest}`;
}
