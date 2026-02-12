import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { restaurantTables, reservations, restaurants } from '@/db/schema';
import { and, eq, gte, or, sql } from 'drizzle-orm';
import { addMinutes, parseISO } from 'date-fns';
import { toZonedTime, format } from 'date-fns-tz';

export const runtime = 'edge';

async function getAvailableTables(restaurantId: string, startTime: Date, partySize: number, duration: number) {
  const endTime = addMinutes(startTime, duration);

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
            gte(reservations.createdAt, new Date(Date.now() - 15 * 60 * 1000))
          )
        ),
        sql`(${reservations.startTime}, ${reservations.endTime}) OVERLAPS (${startTime.toISOString()}::timestamptz, ${endTime.toISOString()}::timestamptz)`
      )
    );

  return await db
    .select()
    .from(restaurantTables)
    .where(
      and(
        eq(restaurantTables.restaurantId, restaurantId),
        eq(restaurantTables.isActive, true),
        eq(restaurantTables.status, 'vacant'),
        gte(restaurantTables.maxCapacity, partySize),
        sql`${restaurantTables.id} NOT IN (${occupiedTableIds})`
      )
    );
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const restaurantId = searchParams.get('restaurantId');
  const date = searchParams.get('date');
  const partySize = parseInt(searchParams.get('partySize') || '0');

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!restaurantId || restaurantId === 'undefined' || !uuidRegex.test(restaurantId) || !date || isNaN(partySize)) {
    return NextResponse.json({ message: 'Missing or invalid parameters' }, { status: 400 });
  }

  try {
    const restaurant = await db.query.restaurants.findFirst({
      where: eq(restaurants.id, restaurantId),
    });

    if (!restaurant) {
      return NextResponse.json({ message: 'Restaurant not found' }, { status: 404 });
    }

    const requestedDate = parseISO(date);
    const timezone = restaurant.timezone || 'UTC';
    const restaurantTime = toZonedTime(requestedDate, timezone);
    
    const dayOfWeek = format(restaurantTime, 'eeee', { timeZone: timezone }).toLowerCase();
    const openDays = restaurant.daysOpen?.split(',').map(d => d.trim().toLowerCase()) || [];
    
    if (!openDays.includes(dayOfWeek)) {
      return NextResponse.json({ message: 'Restaurant is closed on this day', availableTables: [] });
    }

    const timeStr = format(restaurantTime, 'HH:mm', { timeZone: timezone });
    if (timeStr < (restaurant.openingTime || '00:00') || timeStr > (restaurant.closingTime || '23:59')) {
      return NextResponse.json({ message: 'Restaurant is closed at this time', availableTables: [] });
    }

    const duration = restaurant.defaultDurationMinutes || 90;
    const availableTables = await getAvailableTables(restaurantId, requestedDate, partySize, duration);

    const suggestedSlots: { time: string, availableTables: typeof availableTables }[] = [];

    if (availableTables.length === 0) {
      const offsets = [-30, 30, -60, 60];
      for (const offset of offsets) {
        const suggestedTime = addMinutes(requestedDate, offset);
        const suggestedZonedTime = toZonedTime(suggestedTime, timezone);
        const suggestedTimeStr = format(suggestedZonedTime, 'HH:mm', { timeZone: timezone });
        
        if (suggestedTimeStr < (restaurant.openingTime || '00:00') || suggestedTimeStr > (restaurant.closingTime || '23:59')) {
          continue;
        }

        const tables = await getAvailableTables(restaurantId, suggestedTime, partySize, duration);
        if (tables.length > 0) {
          suggestedSlots.push({
            time: suggestedTime.toISOString(),
            availableTables: tables,
          });
        }
      }
    }

    return NextResponse.json({
      restaurantId,
      requestedTime: requestedDate.toISOString(),
      partySize,
      availableTables,
      suggestedSlots: suggestedSlots.length > 0 ? suggestedSlots : undefined,
    });
  } catch (error) {
    console.error('Availability Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
