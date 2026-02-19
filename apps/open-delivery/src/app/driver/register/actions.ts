"use server";

import { db } from "@repo/database";
import { sql } from "drizzle-orm";
import { currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

export interface RegisterDriverResult {
  success: boolean;
  error?: string;
}

/**
 * Register Driver Server Action
 *
 * Creates a new driver profile for the authenticated user.
 */
export async function registerDriver(fullName: string, email: string): Promise<RegisterDriverResult> {
  try {
    // 1. Verify Clerk authentication
    const user = await currentUser();

    if (!user) {
      return { success: false, error: "Unauthorized - please log in" };
    }

    // 2. Check if driver already exists
    const existingDriver = await db.execute(
      sql`SELECT * FROM drivers WHERE clerk_id = ${user.id} LIMIT 1`
    );

    if (existingDriver.rows.length > 0) {
      return { success: false, error: "You already have a driver profile" };
    }

    // 3. Check if email is already registered
    const existingEmail = await db.execute(
      sql`SELECT * FROM drivers WHERE email = ${email.toLowerCase()} LIMIT 1`
    );

    if (existingEmail.rows.length > 0) {
      return { success: false, error: "This email is already registered as a driver" };
    }

    // 4. Create driver profile
    const result = await db.execute(
      sql`
        INSERT INTO drivers (clerk_id, full_name, email, trust_score, is_active, created_at)
        VALUES (${user.id}, ${fullName}, ${email.toLowerCase()}, 80, true, NOW())
        RETURNING *
      `
    );

    if (result.rows.length === 0) {
      return { success: false, error: "Failed to create driver profile" };
    }

    const driver = result.rows[0] as any;

    console.log(`[RegisterDriver] Created driver profile for ${user.id}: ${driver.id}`);

    // 5. Revalidate driver dashboard
    revalidatePath('/driver');

    return { success: true };
  } catch (error) {
    console.error("[RegisterDriver] Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to register as driver"
    };
  }
}
