/**
 * Shared Test Setup
 *
 * Sets up test database schema using drizzle-kit push before test suites run.
 * Ensures integration tests run against real Postgres with up-to-date schema.
 *
 * @package @repo/shared
 */

import { sql } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "@repo/database";

// Lazily import drizzle-kit to avoid hard dependency requirement
async function getPushSchema() {
  try {
    const { pushSchema } = await import("drizzle-kit/api");
    return pushSchema;
  } catch {
    throw new Error(
      "drizzle-kit is required for test database setup. Install it with: pnpm add -D drizzle-kit",
    );
  }
}

/**
 * Push current schema to test database
 * Call this in test setup files
 */
export async function setupTestDatabase(databaseUrl: string): Promise<void> {
  const db = drizzle(sql(databaseUrl));
  const pushSchema = await getPushSchema();

  // Push schema to test database (creates tables if they don't exist)
  await pushSchema(db, schema, {
    // Disable migrations - just push the current state
    migrations: false,
  });
}

/**
 * Clean test database (drop all tables)
 * Call this in test teardown
 */
export async function teardownTestDatabase(databaseUrl: string): Promise<void> {
  const db = drizzle(sql(databaseUrl));

  // Drop all tables (PostgreSQL)
  await db.execute(sql`
    DO $$ DECLARE
      r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
}
