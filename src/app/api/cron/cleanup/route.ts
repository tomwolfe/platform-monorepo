import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { reservations, restaurantTables } from '@/db/schema';
import { and, eq, lt } from 'drizzle-orm';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
    
    // 1. Remove expired unverified reservations
    const deletedReservations = await db.delete(reservations)
      .where(
        and(
          eq(reservations.isVerified, false),
          lt(reservations.createdAt, fifteenMinutesAgo)
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
