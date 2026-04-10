/**
 * Drizzle Configuration
 *
 * Migration Best Practices:
 * 1. ALWAYS use `drizzle-kit generate` to create new migrations
 * 2. NEVER edit SQL migration files manually
 * 3. NEVER commit manual .sql files to migrations/ directory
 * 4. To handle conflicts:
 *    - Run `drizzle-kit drop` to remove the last migration
 *    - Fix your schema, then regenerate
 * 5. To rollback safely:
 *    - Run `drizzle-kit revert` to generate a down migration
 *    - Execute the down migration: `drizzle-kit migrate`
 * 6. Run `pnpm db:check` before committing schema changes
 * 7. CI will fail if schema drift is detected (pnpm db:validate)
 *
 * Strict Mode: Enabled
 * - Enforces schema-migration consistency
 * - Fails on any drift or missing migrations
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema/*.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // Strict mode: fail on any schema drift
  strict: true,
  // Note: 'driver' is removed as of drizzle-kit 0.30.0.
  // It is now automatically detected based on the 'dialect'.
});
