import { NextRequest, NextResponse } from "next/server";
import { getDb, drivers } from "@repo/database";
import { eq } from "drizzle-orm";
import { currentUser } from "@clerk/nextjs/server";
import { Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "open-delivery-driver-profile" });

// Type-safe driver profile from raw SQL query
interface DriverProfileRow {
  id: string;
  full_name: string;
  email: string;
  trust_score: number | null;
  is_active: boolean | null;
}

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
        { status: 401 },
      );
    }

    // 2. Look up driver profile using type-safe Drizzle query
    const driver = await getDb().query.drivers.findFirst({
      where: eq(drivers.clerkId, user.id),
      columns: {
        id: true,
        fullName: true,
        email: true,
        trustScore: true,
        isActive: true,
      },
    });

    if (!driver) {
      return NextResponse.json(
        { error: "No driver profile found" },
        { status: 404 },
      );
    }

    // 3. Return profile
    return NextResponse.json({
      id: driver.id,
      fullName: driver.fullName,
      email: driver.email,
      trustScore: driver.trustScore,
      isActive: driver.isActive,
    });
  } catch (error) {
    logger.error("Driver profile error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        error: "Failed to fetch profile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
