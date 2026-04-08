import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const revalidate = 30; // ISR: Revalidate every 30 seconds
import { getDb } from "@repo/database";
import {
  restaurantTables,
  restaurantReservations,
  restaurants,
} from "@repo/database";
import type { InferSelectModel } from "drizzle-orm";
import { and, eq, gte, or, sql } from "@repo/database";
import { addMinutes, parseISO } from "date-fns";
import { toZonedTime, format } from "date-fns-tz";
import { validateRequest } from "@tablestack/lib/auth";
import {
  formatApiError,
  formatApiSuccess,
  withApiErrorHandler,
  withCache,
  getRedisClient,
  ServiceNamespace,
  Logger,
} from "@repo/shared";

export const runtime = "nodejs";

const logger = new Logger({ serviceName: "table-stack-availability" });

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
      const restaurantId = searchParams.get("restaurantId");
      const date = searchParams.get("date");
      const partySize = parseInt(searchParams.get("partySize") || "0");

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      if (
        !restaurantId ||
        restaurantId === "undefined" ||
        !uuidRegex.test(restaurantId) ||
        !date ||
        isNaN(partySize)
      ) {
        return NextResponse.json(
          formatApiError(
            new Error("Missing or invalid parameters"),
            "VALIDATION_ERROR",
          ),
          { status: 400 },
        );
      }

      // Determine target restaurant ID
      let targetRestaurantId: string;

      const apiKey = req.headers.get("x-api-key");
      if (apiKey) {
        const { error, status, context } = await validateRequest(req);
        if (error)
          return NextResponse.json(
            formatApiError(new Error(error), "UNAUTHORIZED"),
            { status },
          );

        if (restaurantId !== context!.restaurantId) {
          return NextResponse.json(
            formatApiError(
              new Error("Unauthorized access to this restaurant data"),
              "FORBIDDEN",
            ),
            { status: 403 },
          );
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
        return NextResponse.json(
          formatApiError(new Error("Restaurant not found"), "NOT_FOUND"),
          { status: 404 },
        );
      }

      const requestedDate = parseISO(date);
      const timezone = restaurant.timezone || "UTC";
      const restaurantTime = toZonedTime(requestedDate, timezone);

      const dayOfWeek = format(restaurantTime, "eeee", {
        timeZone: timezone,
      }).toLowerCase();
      const openDays =
        restaurant.daysOpen
          ?.split(",")
          .map((d: unknown) => String(d).trim().toLowerCase()) || [];

      if (!openDays.includes(dayOfWeek)) {
        return NextResponse.json(
          formatApiSuccess({
            message: "Restaurant is closed on this day",
            availableTables: [],
          }),
        );
      }

      const timeStr = format(restaurantTime, "HH:mm", { timeZone: timezone });
      const openingTime = restaurant.openingTime || "00:00";
      const closingTime = restaurant.closingTime || "23:59";

      // CRITICAL FIX: Handle overnight hours (e.g., 18:00 to 02:00)
      // If closingTime < openingTime, the restaurant spans midnight.
      const isOvernight = closingTime < openingTime;
      const isClosed = isOvernight
        ? timeStr < openingTime && timeStr > closingTime
        : timeStr < openingTime || timeStr > closingTime;

      if (isClosed) {
        return NextResponse.json(
          formatApiSuccess({
            message: "Restaurant is closed at this time",
            availableTables: [],
          }),
        );
      }

      const duration = restaurant.defaultDurationMinutes || 90;
      const availableTables = await getAvailableTables(
        targetRestaurantId,
        requestedDate,
        partySize,
        duration,
      );

      const suggestedSlots: {
        time: string;
        availableTables: typeof availableTables;
      }[] = [];

      if (availableTables.length === 0) {
        const offsets = [-30, 30, -60, 60];
        for (const offset of offsets) {
          const suggestedTime = addMinutes(requestedDate, offset);
          const suggestedZonedTime = toZonedTime(suggestedTime, timezone);
          const suggestedTimeStr = format(suggestedZonedTime, "HH:mm", {
            timeZone: timezone,
          });

          // Apply same overnight-aware check for suggested slots
          const suggestedIsClosed = isOvernight
            ? suggestedTimeStr < openingTime && suggestedTimeStr > closingTime
            : suggestedTimeStr < openingTime || suggestedTimeStr > closingTime;

          if (suggestedIsClosed) {
            continue;
          }

          const tables = await getAvailableTables(
            targetRestaurantId,
            suggestedTime,
            partySize,
            duration,
          );
          if (tables.length > 0) {
            suggestedSlots.push({
              time: suggestedTime.toISOString(),
              availableTables: tables,
            });
          }
        }
      }

      return NextResponse.json(
        formatApiSuccess({
          restaurantId: targetRestaurantId,
          requestedTime: requestedDate.toISOString(),
          partySize,
          availableTables,
          suggestedSlots:
            suggestedSlots.length > 0 ? suggestedSlots : undefined,
        }),
        {
          headers: {
            "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
          },
        },
      );
    },
    {
      ttl: 30, // 30 second cache for availability
      tags: ["availability"],
      keyPrefix: "availability",
      generateKey: (req: NextRequest) => {
        const { searchParams } = new URL(req.url);
        const restaurantId = searchParams.get("restaurantId");
        const date = searchParams.get("date");
        const partySize = searchParams.get("partySize");
        return `availability:${restaurantId}:${date}:${partySize}`;
      },
    },
  ),
  "EXECUTION_FAILED",
);

async function getAvailableTables(
  restaurantId: string,
  startTime: Date,
  partySize: number,
  duration: number,
) {
  const endTime = addMinutes(startTime, duration);
  const db = getDb();

  // OPTIMIZATION: Use PostgreSQL native overlap operators and capacity filtering
  // This reduces memory bloat by only fetching relevant rows

  // Step 1: Find occupied table IDs using PostgreSQL OVERLAPS operator
  const occupiedTableIdsQuery = db
    .select({
      tableId: restaurantReservations.tableId,
      combinedTableIds: restaurantReservations.combinedTableIds,
    })
    .from(restaurantReservations)
    .where(
      and(
        eq(restaurantReservations.restaurantId, restaurantId),
        or(
          eq(restaurantReservations.status, "confirmed"),
          and(
            eq(restaurantReservations.isVerified, false),
            gte(
              restaurantReservations.createdAt,
              new Date(Date.now() - 15 * 60 * 1000),
            ),
          ),
        ),
        sql`(${restaurantReservations.startTime}, ${restaurantReservations.endTime}) OVERLAPS (${startTime.toISOString()}::timestamptz, ${endTime.toISOString()}::timestamptz)`,
      ),
    );

  const occupiedReservations = await occupiedTableIdsQuery;

  // Build a set of all occupied table IDs (including combined tables)
  const occupiedTableIds = new Set<string>();
  for (const res of occupiedReservations) {
    if (res.tableId) {
      occupiedTableIds.add(res.tableId);
    }
    if (res.combinedTableIds && Array.isArray(res.combinedTableIds)) {
      res.combinedTableIds.forEach((id: string) => occupiedTableIds.add(id));
    }
  }

  // Step 2: Fetch only available tables that match capacity requirements
  // OPTIMIZATION: Filter by capacity and status in SQL, not in memory
  const occupiedIdsArray = Array.from(occupiedTableIds);
  const notInCondition =
    occupiedTableIds.size > 0
      ? sql`${restaurantTables.id} NOT IN (${sql.join(
          occupiedIdsArray.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql`1=1`;

  const availableIndividualTables = await db
    .select({
      id: restaurantTables.id,
      tableNumber: restaurantTables.tableNumber,
      maxCapacity: restaurantTables.maxCapacity,
      minCapacity: restaurantTables.minCapacity,
      tableType: restaurantTables.tableType,
      xPos: restaurantTables.xPos,
      yPos: restaurantTables.yPos,
    })
    .from(restaurantTables)
    .where(
      and(
        eq(restaurantTables.restaurantId, restaurantId),
        eq(restaurantTables.isActive, true),
        eq(restaurantTables.status, "vacant"),
        sql`${restaurantTables.maxCapacity} >= ${partySize}`,
        notInCondition,
      ),
    );

  if (availableIndividualTables.length > 0) {
    return availableIndividualTables.map((t) => ({
      ...t,
      isCombined: false,
    }));
  }

  // Step 3: If no individual table fits, try joining two tables
  // OPTIMIZATION: Only fetch vacant tables with sufficient combined capacity
  const vacantTables = await db
    .select({
      id: restaurantTables.id,
      tableNumber: restaurantTables.tableNumber,
      maxCapacity: restaurantTables.maxCapacity,
      minCapacity: restaurantTables.minCapacity,
    })
    .from(restaurantTables)
    .where(
      and(
        eq(restaurantTables.restaurantId, restaurantId),
        eq(restaurantTables.isActive, true),
        eq(restaurantTables.status, "vacant"),
        notInCondition,
      ),
    );

  const suggestedCombos: Array<{
    id: string;
    tableNumber: string;
    combinedTableIds: string[];
    maxCapacity: number;
    isCombined: boolean;
    table1: typeof restaurantTables.$inferSelect;
    table2: typeof restaurantTables.$inferSelect;
  }> = [];

  // Circuit breaker: limit combinations to prevent O(N^2) event-loop blocking
  const MAX_COMBOS = 5; // Return top 5 combinations max
  let comboCount = 0;

  // Pre-filter: exclude tables that cannot possibly satisfy partySize even when combined
  // with the largest available table
  const MAX_KNOWN_TABLE_CAPACITY =
    vacantTables.length > 0
      ? Math.max(...vacantTables.map((t) => t.maxCapacity))
      : 0;

  const feasibleTables = vacantTables.filter(
    (t) => t.maxCapacity + MAX_KNOWN_TABLE_CAPACITY >= partySize,
  );

  comboSearch: for (let i = 0; i < feasibleTables.length; i++) {
    const t1 = feasibleTables[i];
    if (!t1) continue;

    // Early continue: if t1 alone satisfies partySize, it would have been caught by single-table check
    if (t1.maxCapacity >= partySize) continue;

    for (let j = i + 1; j < feasibleTables.length; j++) {
      if (comboCount >= MAX_COMBOS) break comboSearch;
      const t2 = feasibleTables[j];
      if (!t1 || !t2) continue;

      // Join capacity check - only compute distance if capacity is sufficient
      const combinedCapacity = t1.maxCapacity + t2.maxCapacity;
      if (combinedCapacity < partySize) continue;

      // Check adjacency (distance formula with threshold)
      const distance = Math.sqrt(
        Math.pow((t1.xPos || 0) - (t2.xPos || 0), 2) +
          Math.pow((t1.yPos || 0) - (t2.yPos || 0), 2),
      );

      if (distance < 120) {
        // Adjacency threshold in floor plan units
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

  // Log when circuit breaker limits combinations — ops teams need visibility
  if (
    comboCount >= MAX_COMBOS &&
    (vacantTables.length * (vacantTables.length - 1)) / 2 > MAX_COMBOS
  ) {
    logger.info("Table combination search capped by circuit breaker", {
      maxCombos: MAX_COMBOS,
      vacantTableCount: vacantTables.length,
      possibleCombos: (vacantTables.length * (vacantTables.length - 1)) / 2,
    });
  }

  return suggestedCombos;
}
