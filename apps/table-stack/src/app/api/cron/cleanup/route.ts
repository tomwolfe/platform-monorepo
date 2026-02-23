import { NextRequest, NextResponse } from 'next/server';
import { db, eq, lt, and } from "@repo/database";
import { restaurantReservations, restaurantTables } from "@repo/database";

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);

    // 1. Remove expired unverified restaurantReservations
    const deletedReservations = await db.delete(restaurantReservations)
      .where(
        and(
          eq(restaurantReservations.isVerified, false),
          lt(restaurantReservations.createdAt, fifteenMinutesAgo)
        )
      );

    // 2. Auto-archive "dirty" tables to "vacant"
    const cleanedTables = await db.update(restaurantTables)
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
