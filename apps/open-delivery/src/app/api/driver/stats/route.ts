import { NextRequest, NextResponse } from "next/server";
import { db, drivers as driversTable, orders as ordersTable, eq, sql, and, gte, lt } from "@repo/database";
import { currentUser } from "@clerk/nextjs/server";

interface DriverStats {
  id: string;
  trustScore: number;
}

interface StatsResult {
  deliveriesCount: number;
  totalEarnings: number;
  avgMinutesPerDelivery: number;
}

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

    // 2. Look up driver profile with proper typing
    const driverResult = await db
      .select({
        id: driversTable.id,
        trustScore: driversTable.trustScore,
      })
      .from(driversTable)
      .where(eq(driversTable.clerkId, user.id))
      .limit(1);

    const driver = driverResult[0];

    if (!driver) {
      return NextResponse.json(
        { error: "No driver profile found" },
        { status: 404 }
      );
    }

    const driverId = driver.id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 3. Fetch today's completed deliveries and earnings with proper typing
    const statsResult = await db
      .select({
        deliveriesCount: sql<number>`COUNT(*) FILTER (WHERE ${ordersTable.status} = 'delivered')`,
        totalEarnings: sql<number>`COALESCE(SUM(${ordersTable.total}) FILTER (WHERE ${ordersTable.status} = 'delivered'), 0)`,
        avgMinutesPerDelivery: sql<number>`COALESCE(
          AVG(
            EXTRACT(EPOCH FROM (${ordersTable.updatedAt} - ${ordersTable.createdAt})) / 60
          ) FILTER (WHERE ${ordersTable.status} = 'delivered'),
          0
        )`,
      })
      .from(ordersTable)
      .where(
        and(
          eq(ordersTable.driverId, driverId),
          gte(ordersTable.createdAt, today),
          lt(ordersTable.createdAt, tomorrow)
        )
      );

    const stats = statsResult[0];

    if (!stats) {
      return NextResponse.json(
        { error: "Failed to fetch statistics" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      todayEarnings: stats.totalEarnings || 0,
      deliveriesCount: stats.deliveriesCount || 0,
      avgTimePerDelivery: Math.round(stats.avgMinutesPerDelivery || 0),
      trustScore: driver.trustScore || 80,
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
