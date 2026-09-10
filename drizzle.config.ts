import { defineConfig } from "drizzle-kit";
import { resolveUserDataDir, userDataDbPath } from "./src/shared/user-data-paths";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: userDataDbPath(resolveUserDataDir()),
  },
  strict: true,
  verbose: true,
});
