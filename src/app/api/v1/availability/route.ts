import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { restaurantTables, reservations } from '@/db/schema';
import { and, eq, gte, lte, ne, or, sql } from 'drizzle-orm';
import { addMinutes, parseISO, startOfDay, endOfDay } from 'date-fns';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const restaurantId = searchParams.get('restaurantId');
  const date = searchParams.get('date');
  const partySize = parseInt(searchParams.get('partySize') || '0');

  if (!restaurantId || !date || isNaN(partySize)) {
    return NextResponse.json({ message: 'Missing parameters' }, { status: 400 });
  }

  try {
    const requestedDate = parseISO(date);
    
    // For a real production app, we'd iterate through time slots (e.g. every 30 mins)
    // But for this API, let's assume we are checking availability for a specific time 
    // or just returning all tables available at ANY time on that day?
    // Usually, availability is for a specific time. Let's assume 'date' is a full ISO string.
    
    const startTime = requestedDate;
    const endTime = addMinutes(startTime, 90);

    // Find tables that fit the party size and are NOT occupied
    // Logic: 
    // NOT IN (
    //   SELECT table_id FROM reservations 
    //   WHERE restaurant_id = $1
    //     AND (status = 'confirmed' OR (is_verified = false AND created_at > now() - interval '20 minutes'))
    //     AND (start_time, end_time) OVERLAPS ($3, $4)
    // )

    const occupiedTableIds = db
      .select({ tableId: reservations.tableId })
      .from(reservations)
      .where(
        and(
          eq(reservations.restaurantId, restaurantId),
          or(
            eq(reservations.status, 'confirmed'),
            and(
              eq(reservations.isVerified, false),
              gte(reservations.createdAt, new Date(Date.now() - 20 * 60 * 1000))
            )
          ),
          sql`(${reservations.startTime}, ${reservations.endTime}) OVERLAPS (${startTime.toISOString()}, ${endTime.toISOString()})`
        )
      );

    const availableTables = await db
      .select()
      .from(restaurantTables)
      .where(
        and(
          eq(restaurantTables.restaurantId, restaurantId),
          eq(restaurantTables.isActive, true),
          gte(restaurantTables.maxCapacity, partySize),
          lte(restaurantTables.minCapacity, partySize),
          sql`${restaurantTables.id} NOT IN (${occupiedTableIds})`
        )
      );

    return NextResponse.json({
      restaurantId,
      date: startTime.toISOString(),
      partySize,
      availableTables,
    });
  } catch (error) {
    console.error('Availability Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
