/**
 * Drizzle Configuration
 *
 * Migration Best Practices:
 * 1. ALWAYS use `drizzle-kit generate` to create new migrations
 * 2. NEVER edit SQL migration files manually
 * 3. To handle conflicts:
 *    - Run `drizzle-kit drop` to remove the last migration
 *    - Fix your schema, then regenerate
 * 4. To rollback safely:
 *    - Run `drizzle-kit revert` to generate a down migration
 *    - Execute the down migration: `drizzle-kit migrate`
 * 5. Run `pnpm db:validate` before committing schema changes
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/*.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // Note: 'driver' is removed as of drizzle-kit 0.30.0.
  // It is now automatically detected based on the 'dialect'.
});
