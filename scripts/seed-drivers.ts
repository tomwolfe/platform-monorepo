/**
 * Seed script for OpenDeliver drivers table
 * Run with: pnpm --filter @repo/open-delivery tsx ../../scripts/seed-drivers.ts
 */

import { getDb } from "../packages/database/src/index";
import { drivers } from "../packages/database/src/schema/tablestack";
import { sql } from "drizzle-orm";

export async function seedDrivers() {
  console.log("🚀 Seeding drivers table...");

  // Replace with your actual Dev Clerk ID from the Clerk dashboard
  const TEST_CLERK_ID = process.env.TEST_DRIVER_CLERK_ID || process.env.CLERK_USER_ID || "user_2abc123xyz";
  
  try {
    // Check if driver already exists
    const existing = await getDb().execute(
      sql`SELECT * FROM drivers WHERE clerk_id = ${TEST_CLERK_ID} LIMIT 1`
    );

    if (existing.rows.length > 0) {
      console.log("ℹ️  Driver already exists, updating...");
      await getDb().execute(
        sql`UPDATE drivers SET 
          is_active = true, 
          trust_score = 95,
          last_online = NOW()
        WHERE clerk_id = ${TEST_CLERK_ID}`
      );
    } else {
      await getDb().execute(
        sql`INSERT INTO drivers (clerk_id, full_name, email, trust_score, is_active)
         VALUES (${TEST_CLERK_ID}, 'Demo Driver', 'driver@demo.com', 95, true)
         ON CONFLICT (clerk_id) DO UPDATE SET
          is_active = true,
          trust_score = 95,
          last_online = NOW()`
      );
    }
    
    console.log("✅ Driver seeded and linked to Clerk");
    console.log(`   Clerk ID: ${TEST_CLERK_ID}`);
    console.log(`   Email: driver@demo.com`);
    console.log(`   Trust Score: 95`);
    console.log(`   Status: Active`);
  } catch (error) {
    console.error("❌ Failed to seed drivers:", error);
    throw error;
  }
}

// Run if executed directly
seedDrivers()
  .then(() => {
    console.log("✅ Seed completed successfully");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  });
