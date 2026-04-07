import { NextRequest, NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
import { getDb } from "@repo/database";
import { restaurantTables, restaurantReservations, restaurants } from "@repo/database";
import type { InferSelectModel } from 'drizzle-orm';
import { and, eq, gte, or, sql } from '@repo/database';
import { addMinutes, parseISO } from 'date-fns';
import { toZonedTime, format } from 'date-fns-tz';
import { validateRequest } from '@tablestack/lib/auth';
import { formatApiError, formatApiSuccess, withApiErrorHandler, withCache, getRedisClient, ServiceNamespace, Logger } from '@repo/shared';

export const runtime = 'nodejs';

const logger = new Logger({ serviceName: 'table-stack-availability' });

// Type aliases for Drizzle query results
type RestaurantTable = typeof restaurantTables.$inferSelect;
type RestaurantReservation = typeof restaurantReservations.$inferSelect;

const redis = getRedisClient(ServiceNamespace.TS);

/**
 * GET /api/v1/availability
 *
 * Check table availability for a given date/time and party size.
 * Results are cached for 30 seconds to reduce database load.
 *
 * Query Parameters:
 * - restaurantId: UUID (required)
 * - date: ISO 8601 datetime (required)
 * - partySize: number (required)
 *
 * Response:
 * - availableTables: Array of available tables
 * - suggestedSlots: Alternative time slots if unavailable
 *
 * Caching:
 * - TTL: 30 seconds
 * - Cache Key: availability:{restaurantId}:{date}:{partySize}
 * - Tags: ['availability', 'restaurant:{id}']
 */
export const GET = withApiErrorHandler(
  withCache(
    async (req: NextRequest) => {
      const { searchParams } = new URL(req.url);
      const restaurantId = searchParams.get('restaurantId');
      const date = searchParams.get('date');
      const partySize = parseInt(searchParams.get('partySize') || '0');

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (!restaurantId || restaurantId === 'undefined' || !uuidRegex.test(restaurantId) || !date || isNaN(partySize)) {
        return NextResponse.json(formatApiError(new Error('Missing or invalid parameters'), 'VALIDATION_ERROR'), { status: 400 });
      }

      // Determine target restaurant ID
      let targetRestaurantId: string;

      const apiKey = req.headers.get('x-api-key');
      if (apiKey) {
        const { error, status, context } = await validateRequest(req);
        if (error) return NextResponse.json(formatApiError(new Error(error), 'UNAUTHORIZED'), { status });

        if (restaurantId !== context!.restaurantId) {
          return NextResponse.json(formatApiError(new Error('Unauthorized access to this restaurant data'), 'FORBIDDEN'), { status: 403 });
        }
        targetRestaurantId = context!.restaurantId;
      } else {
        // If no API key, we allow public availability checks for a specific restaurant
        targetRestaurantId = restaurantId;
      }

      const restaurant = await getDb().query.restaurants.findFirst({
        where: eq(restaurants.id, targetRestaurantId),
      });

      if (!restaurant) {
        return NextResponse.json(formatApiError(new Error('Restaurant not found'), 'NOT_FOUND'), { status: 404 });
      }

      const requestedDate = parseISO(date);
      const timezone = restaurant.timezone || 'UTC';
      const restaurantTime = toZonedTime(requestedDate, timezone);

      const dayOfWeek = format(restaurantTime, 'eeee', { timeZone: timezone }).toLowerCase();
      const openDays = restaurant.daysOpen?.split(',').map((d: unknown) => String(d).trim().toLowerCase()) || [];

      if (!openDays.includes(dayOfWeek)) {
        return NextResponse.json(formatApiSuccess({ message: 'Restaurant is closed on this day', availableTables: [] }));
      }

      const timeStr = format(restaurantTime, 'HH:mm', { timeZone: timezone });
      if (timeStr < (restaurant.openingTime || '00:00') || timeStr > (restaurant.closingTime || '23:59')) {
        return NextResponse.json(formatApiSuccess({ message: 'Restaurant is closed at this time', availableTables: [] }));
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

      return NextResponse.json(formatApiSuccess({
        restaurantId: targetRestaurantId,
        requestedTime: requestedDate.toISOString(),
        partySize,
        availableTables,
        suggestedSlots: suggestedSlots.length > 0 ? suggestedSlots : undefined,
      }));
    },
    {
      ttl: 30, // 30 second cache for availability
      tags: ['availability'],
      keyPrefix: 'availability',
      generateKey: (req: NextRequest) => {
        const { searchParams } = new URL(req.url);
        const restaurantId = searchParams.get('restaurantId');
        const date = searchParams.get('date');
        const partySize = searchParams.get('partySize');
        return `availability:${restaurantId}:${date}:${partySize}`;
      },
    }
  ),
  'EXECUTION_FAILED'
);

async function getAvailableTables(restaurantId: string, startTime: Date, partySize: number, duration: number) {
  const endTime = addMinutes(startTime, duration);
  const db = getDb();

  const occupiedTableIdsQuery = db
    .select({ tableId: restaurantReservations.tableId })
    .from(restaurantReservations)
    .where(
      and(
        eq(restaurantReservations.restaurantId, restaurantId),
        or(
          eq(restaurantReservations.status, 'confirmed'),
          and(
            eq(restaurantReservations.isVerified, false),
            gte(restaurantReservations.createdAt, new Date(Date.now() - 15 * 60 * 1000))
          )
        ),
        sql`(${restaurantReservations.startTime}, ${restaurantReservations.endTime}) OVERLAPS (${sql.placeholder(startTime.toISOString())}::timestamptz, ${sql.placeholder(endTime.toISOString())}::timestamptz)`
      )
    );

  const occupiedTableIdsResult = await occupiedTableIdsQuery;
  const occupiedTableIds = occupiedTableIdsResult
    .map((r: { tableId: string | null }) => r.tableId)
    .filter((id): id is string => Boolean(id));

  // Also check combinedTableIds from restaurantReservations
  const occupiedCombinedTableIdsQuery = await db
    .select({ combinedTableIds: restaurantReservations.combinedTableIds })
    .from(restaurantReservations)
    .where(
      and(
        eq(restaurantReservations.restaurantId, restaurantId),
        or(
          eq(restaurantReservations.status, 'confirmed'),
          and(
            eq(restaurantReservations.isVerified, false),
            gte(restaurantReservations.createdAt, new Date(Date.now() - 15 * 60 * 1000))
          )
        ),
        sql`(${restaurantReservations.startTime}, ${restaurantReservations.endTime}) OVERLAPS (${sql.placeholder(startTime.toISOString())}::timestamptz, ${sql.placeholder(endTime.toISOString())}::timestamptz)`
      )
    );

  occupiedCombinedTableIdsQuery.forEach((r: { combinedTableIds: RestaurantReservation['combinedTableIds'] }) => {
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

  const availableIndividualTables = allTables.filter((t: RestaurantTable) =>
    !occupiedTableIds.includes(t.id) && t.maxCapacity >= partySize
  );

  if (availableIndividualTables.length > 0) {
    return availableIndividualTables.map((t: RestaurantTable) => ({ ...t, isCombined: false }));
  }

  // If no individual table fits, try joining two tables
  // OPTIMIZATION: Only attempt combinations when individual tables are insufficient
  const vacantTables = allTables.filter((t: RestaurantTable) => !occupiedTableIds.includes(t.id));
  const suggestedCombos: Array<{
    id: string;
    tableNumber: string;
    combinedTableIds: string[];
    maxCapacity: number;
    isCombined: boolean;
    table1: RestaurantTable;
    table2: RestaurantTable;
  }> = [];

  // Circuit breaker: limit combinations to prevent O(N^2) event-loop blocking
  const MAX_COMBOS = 5; // Return top 5 combinations max
  let comboCount = 0;

  comboSearch:
  for (let i = 0; i < vacantTables.length; i++) {
    for (let j = i + 1; j < vacantTables.length; j++) {
      if (comboCount >= MAX_COMBOS) break comboSearch;
      const t1 = vacantTables[i];
      const t2 = vacantTables[j];
      
      if (!t1 || !t2) continue;

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
          comboCount++;
        }
      }
    }
  }

  // Log when circuit breaker limits combinations — ops teams need visibility
  if (comboCount >= MAX_COMBOS && vacantTables.length * (vacantTables.length - 1) / 2 > MAX_COMBOS) {
    logger.info('Table combination search capped by circuit breaker', {
      maxCombos: MAX_COMBOS,
      vacantTableCount: vacantTables.length,
      possibleCombos: vacantTables.length * (vacantTables.length - 1) / 2,
    });
  }

  return suggestedCombos;
}
