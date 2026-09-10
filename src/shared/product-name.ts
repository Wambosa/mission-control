/**
 * What the product is called, in the two forms that are not interchangeable.
 *
 * Deliberately its own module with no imports. The renderer needs the display
 * name for the window title and the wordmark, and every other home for these
 * constants — the path resolver, the migration — reaches for `node:fs` at
 * module scope. Importing one of those from a component pulls a filesystem
 * module into the client graph, where it externalizes to a stub that
 * typechecks, builds, and then throws in the browser.
 */

/** The product as a person reads it. Carries the space. */
export const PRODUCT_DISPLAY_NAME = "Chaos Wrangler";

/**
 * The on-disk directory token, and the name handed to the platform's name
 * setter. Deliberately unspaced — this app shells out constantly, and a space
 * in a path that every remote and terminal code path interpolates buys nothing
 * a user ever sees. Mirrors the split that already existed between the spaced
 * product name and the unspaced directory.
 */
export const USER_DATA_DIR_NAME = "ChaosWrangler";
