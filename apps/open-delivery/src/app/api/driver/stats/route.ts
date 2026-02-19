import { NextRequest, NextResponse } from "next/server";
import { db } from "@repo/database";
import { sql } from "drizzle-orm";
import { currentUser } from "@clerk/nextjs/server";

/**
 * Driver Statistics API Route
 *
 * Returns real-time statistics for the current driver:
 * - Today's earnings (from completed deliveries)
 * - Number of deliveries today
 * - Average time per delivery
 * - Current trust score
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
      sql`SELECT id, trust_score FROM drivers WHERE clerk_id = ${user.id} LIMIT 1`
    );

    const driver = driverResult.rows[0] as any | undefined;

    if (!driver) {
      return NextResponse.json(
        { error: "No driver profile found" },
        { status: 404 }
      );
    }

    const driverId = driver.id;
    const today = new Date().toISOString().split("T")[0];

    // 3. Fetch today's completed deliveries and earnings
    const statsResult = await db.execute(
      sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'delivered') as deliveries_count,
          COALESCE(SUM(payout_amount) FILTER (WHERE status = 'delivered'), 0) as total_earnings,
          COALESCE(
            AVG(
              EXTRACT(EPOCH FROM (updated_at - created_at)) / 60
            ) FILTER (WHERE status = 'delivered'),
            0
          ) as avg_minutes_per_delivery
        FROM orders
        WHERE driver_id = ${driverId}
          AND DATE(created_at) = DATE(${today})
      `
    );

    const stats = statsResult.rows[0] as any;

    return NextResponse.json({
      todayEarnings: parseFloat(stats.total_earnings) || 0,
      deliveriesCount: parseInt(stats.deliveries_count) || 0,
      avgTimePerDelivery: Math.round(parseFloat(stats.avg_minutes_per_delivery) || 0),
      trustScore: driver.trust_score || 80,
    });
  } catch (error) {
    console.error("Driver stats error:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch statistics",
        details: error instanceof Error ? error.message : "Unknown error"
      },
      { status: 500 }
    );
  }
}
