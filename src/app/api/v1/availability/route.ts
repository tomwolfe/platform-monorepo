import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { restaurantTables, reservations, restaurants } from '@/db/schema';
import { and, eq, gte, or, sql } from 'drizzle-orm';
import { addMinutes, parseISO } from 'date-fns';
import { toZonedTime, format } from 'date-fns-tz';
import { validateRequest } from '@/lib/auth';

export const runtime = 'edge';

async function getAvailableTables(restaurantId: string, startTime: Date, partySize: number, duration: number) {
  const endTime = addMinutes(startTime, duration);

  const occupiedTableIdsQuery = db
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

  const occupiedTableIdsResult = await occupiedTableIdsQuery;
  const occupiedTableIds = occupiedTableIdsResult.map(r => r.tableId).filter(Boolean) as string[];

  // Also check combinedTableIds from reservations
  const occupiedCombinedTableIdsQuery = await db
    .select({ combinedTableIds: reservations.combinedTableIds })
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

  occupiedCombinedTableIdsQuery.forEach(r => {
    if (r.combinedTableIds) {
      occupiedTableIds.push(...r.combinedTableIds);
    }
  });

  const allTables = await db
    .select()
    .from(restaurantTables)
    .where(
      and(
        eq(restaurantTables.restaurantId, restaurantId),
        eq(restaurantTables.isActive, true),
        eq(restaurantTables.status, 'vacant')
      )
    );

  const availableIndividualTables = allTables.filter(t => 
    !occupiedTableIds.includes(t.id) && t.maxCapacity >= partySize
  );

  if (availableIndividualTables.length > 0) {
    return availableIndividualTables.map(t => ({ ...t, isCombined: false }));
  }

  // If no individual table fits, try joining two tables
  // For simplicity, we only try joining TWO adjacent tables
  const vacantTables = allTables.filter(t => !occupiedTableIds.includes(t.id));
  const suggestedCombos: any[] = [];

  for (let i = 0; i < vacantTables.length; i++) {
    for (let j = i + 1; j < vacantTables.length; j++) {
      const t1 = vacantTables[i];
      const t2 = vacantTables[j];

      // Join capacity (e.g., two 2-tops = 4-top)
      const combinedCapacity = t1.maxCapacity + t2.maxCapacity;
      
      if (combinedCapacity >= partySize) {
        // Check adjacency (distance formula with threshold)
        const distance = Math.sqrt(
          Math.pow((t1.xPos || 0) - (t2.xPos || 0), 2) + 
          Math.pow((t1.yPos || 0) - (t2.yPos || 0), 2)
        );

        if (distance < 120) { // Adjacency threshold in floor plan units
          suggestedCombos.push({
            id: `${t1.id}+${t2.id}`,
            tableNumber: `${t1.tableNumber}+${t2.tableNumber}`,
            combinedTableIds: [t1.id, t2.id],
            maxCapacity: combinedCapacity,
            isCombined: true,
            table1: t1,
            table2: t2,
          });
        }
      }
    }
  }

  return suggestedCombos;
}

export async function GET(req: NextRequest) {
  const { error, status, context } = await validateRequest(req);
  if (error) return NextResponse.json({ message: error }, { status });

  const { searchParams } = new URL(req.url);
  const restaurantId = searchParams.get('restaurantId');
  
  if (restaurantId && restaurantId !== context!.restaurantId) {
    return NextResponse.json({ message: 'Unauthorized access to this restaurant data' }, { status: 403 });
  }

  const targetRestaurantId = context!.restaurantId;
  const date = searchParams.get('date');
  const partySize = parseInt(searchParams.get('partySize') || '0');

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!restaurantId || restaurantId === 'undefined' || !uuidRegex.test(restaurantId) || !date || isNaN(partySize)) {
    return NextResponse.json({ message: 'Missing or invalid parameters' }, { status: 400 });
  }

  try {
    const restaurant = await db.query.restaurants.findFirst({
      where: eq(restaurants.id, targetRestaurantId),
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
    const availableTables = await getAvailableTables(targetRestaurantId, requestedDate, partySize, duration);

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

        const tables = await getAvailableTables(targetRestaurantId, suggestedTime, partySize, duration);
        if (tables.length > 0) {
          suggestedSlots.push({
            time: suggestedTime.toISOString(),
            availableTables: tables,
          });
        }
      }
    }

    return NextResponse.json({
      restaurantId: targetRestaurantId,
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
