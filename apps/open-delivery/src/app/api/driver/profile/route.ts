import { NextRequest, NextResponse } from "next/server";
import { db } from "@repo/database";
import { sql } from "drizzle-orm";
import { currentUser } from "@clerk/nextjs/server";

/**
 * Driver Profile API Route
 *
 * Returns the current user's driver profile if they have one.
 * Returns 404 if no profile exists.
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Get authenticated user
    const user = await currentUser();

    if (!user) {
      return NextResponse.json(
        { error: "Unauthorized - please log in" },
        { status: 401 }
      );
    }

    // 2. Look up driver profile
    const driverResult = await db.execute(
      sql`SELECT id, full_name, email, trust_score, is_active FROM drivers WHERE clerk_id = ${user.id} LIMIT 1`
    );

    const driver = driverResult.rows[0] as any | undefined;

    if (!driver) {
      return NextResponse.json(
        { error: "No driver profile found" },
        { status: 404 }
      );
    }

    // 3. Return profile
    return NextResponse.json({
      id: driver.id,
      fullName: driver.full_name,
      email: driver.email,
      trustScore: driver.trust_score,
      isActive: driver.is_active,
    });
  } catch (error) {
    console.error("Driver profile error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch profile",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    );
  }
}
