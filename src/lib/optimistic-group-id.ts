/**
 * The id convention for a group that exists only in the cache while its
 * create is in flight. The server has never seen it, so every surface that
 * offers to select or edit a group has to be able to recognize one.
 *
 * Kept dependency-free so the scope derivation can import it without pulling
 * the mutation machinery (and its toast/api imports) along with it.
 */
export const OPTIMISTIC_GROUP_ID_PREFIX = "optimistic-group-";

export function isOptimisticGroupId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_GROUP_ID_PREFIX);
}
