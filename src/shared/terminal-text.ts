/**
 * Turning raw terminal bytes into something a person can read.
 *
 * The stripper below is the one that has been in this repo since generated
 * session titles started leaking escape sequences. It is moved here rather than
 * reimplemented: it already covers the sequence families an agent TUI emits,
 * and it exists because getting that list wrong has already cost once. One
 * implementation, one test surface.
 */

const ANSI_ESCAPE_REGEX =
  /(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[PX^_].*?(?:\x1b\\)|\x1b[@-_])/g;
const CONTROL_CHARS_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
// Terminals echo a colour-query reply back into the stream; without this it
// lands in the output as `rgb:1c1c/1c1c/1c1c`.
const ORPHANED_TERMINAL_RGB_RESPONSE_REGEX =
  /(?:\]?\d{1,2};)?rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}/g;

/** Remove control sequences, OSC/DCS strings, stray control bytes and colour replies. */
export function stripTerminalControlText(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE_REGEX, "")
    .replace(ORPHANED_TERMINAL_RGB_RESPONSE_REGEX, "")
    .replace(CONTROL_CHARS_REGEX, "");
}

/**
 * How much of a ring is worth looking at.
 *
 * Matches the scan cap the repo's other output classifier already uses, and
 * bounds every regex in the signature catalogue by construction.
 */
export const TERMINAL_TAIL_SCAN_CAP = 8_000;

/** How many legible lines a tail keeps. Enough to carry a blocking path and its context. */
const TAIL_MAX_LINES = 12;

/**
 * Resolve carriage-return rewrites to the final content of each line.
 *
 * A progress bar redraws by returning to column zero and printing over itself,
 * so the raw bytes hold every frame it ever drew. Only the last one was ever on
 * screen, and it is the only one worth showing.
 */
function resolveCarriageReturns(line: string): string {
  const frames = line.split("\r");
  return frames[frames.length - 1] ?? "";
}

/**
 * The legible tail of a terminal ring, or null when nothing legible survives.
 *
 * Null rather than an ellipsis on purpose. The three main agent CLIs redraw
 * rather than append, so the last kilobytes of a full-screen TUI are cursor
 * addressing and partial repaints — stripping those leaves interleaved
 * fragments, not a description of what the session was doing. Reporting that as
 * absent is honest; rendering it would put noise in front of an operator and
 * call it evidence.
 */
export function extractTerminalTail(raw: string): string | null {
  if (!raw) return null;
  const capped = raw.length > TERMINAL_TAIL_SCAN_CAP ? raw.slice(-TERMINAL_TAIL_SCAN_CAP) : raw;

  const lines = stripTerminalControlText(capped)
    .split("\n")
    .map((line) => resolveCarriageReturns(line).replace(/[ \t]+/g, " ").trim())
    // A line with nothing but box-drawing, spacing or punctuation is repaint
    // furniture, not content.
    .filter((line) => /[\p{L}\p{N}]/u.test(line));

  if (lines.length === 0) return null;
  return lines.slice(-TAIL_MAX_LINES).join("\n");
}
