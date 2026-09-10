import { defineConfig } from "drizzle-kit";
import { userDataDbPath } from "./src/shared/user-data-paths";
import { resolveStandaloneUserDataDir } from "./src/shared/user-data-migration";

// Run outside the app, this must not stand up a database at the new location
// before the app has migrated to it — the migration would then have to report
// its own destination as a conflict.
const { directory, notice } = resolveStandaloneUserDataDir();
if (notice) console.warn(`[drizzle] ${notice}`);

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
