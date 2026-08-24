import { defineConfig } from "drizzle-kit";

/**
 * How `drizzle-kit generate` derives a migration from `src/schema.ts`.
 *
 * No `dbCredentials`, and that is not an omission. Generation diffs the schema against the
 * migrations already in `drizzle/`, which is a pure function of files in this repository — so it
 * needs no database and cannot be run against the wrong one. The connection string lives in
 * `REGISTRY_DATABASE_URL` and is read at runtime by `client.ts`, never here.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
