import { NextRequest, NextResponse } from 'next/server';
import { getDb, eq, lt, and } from "@repo/database";
import { restaurantReservations, restaurantTables } from "@repo/database";
import { withCronAuth } from '@repo/shared';

export const runtime = 'nodejs';

async function getCronHandler(req: NextRequest) {
  try {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);

    // 1. Remove expired unverified restaurantReservations
    const deletedReservations = await getDb().delete(restaurantReservations)
      .where(
        and(
          eq(restaurantReservations.isVerified, false),
          lt(restaurantReservations.createdAt, fifteenMinutesAgo)
        )
      );

    // 2. Auto-archive "dirty" tables to "vacant"
    const cleanedTables = await getDb().update(restaurantTables)
      .set({ status: 'vacant', updatedAt: new Date() })
      .where(
        and(
          eq(restaurantTables.status, 'dirty'),
          lt(restaurantTables.updatedAt, twentyMinutesAgo)
        )
      );

    return NextResponse.json({
      message: 'Cleanup successful',
      timestamp: new Date().toISOString(),
      expiredReservationsRemoved: deletedReservations.rowCount,
      dirtyTablesCleaned: cleanedTables.rowCount,
    });
  } catch (error) {
    console.error('Cleanup Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}

// Wrap handler with cron authentication
export const GET = withCronAuth(getCronHandler);
