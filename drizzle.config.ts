import { defineConfig } from "drizzle-kit";
import { userDataDbPath } from "./src/shared/user-data-paths";
import { resolveStandaloneUserDataDir } from "./src/shared/user-data-migration";

// Run outside the app, this must not stand up a database at the new location
// before the app has migrated to it — the migration would then have to report
// its own destination as a conflict.
//
// And it refuses rather than falling back. This is a schema push: pointing it
// at the previous location would have it write into whatever real store is
// there. Agent terminals do not inherit the data-directory override (it is a
// map to the credential store, so the session sanitizer strips it), which makes
// "fall back quietly" the difference between touching a scratch database and
// touching the user's own.
const { directory, notice } = resolveStandaloneUserDataDir();
if (notice) {
  throw new Error(
    `${notice}\nRefusing to run a schema push against the previous data folder. Set MC_USER_DATA_DIR to choose a database explicitly.`,
  );
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: userDataDbPath(directory),
  },
  strict: true,
  verbose: true,
});
