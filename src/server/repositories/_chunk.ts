/**
 * Split a list into fixed-size batches.
 *
 * Lives beside the other repository helpers because both callers need it for
 * the same reason: SQLite caps how many bound variables one statement may
 * carry, so an `IN (...)` list built from an unbounded row set has to be issued
 * in slices.
 */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
