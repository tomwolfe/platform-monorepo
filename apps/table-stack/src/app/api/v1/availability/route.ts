import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const revalidate = 30;
import {
  getDb,
  restaurants,
  restaurantTables,
  restaurantReservations,
  eq,
} from "@repo/database";
import type { InferSelectModel } from "drizzle-orm";
import { addMinutes, parseISO } from "date-fns";
import { toZonedTime, format } from "date-fns-tz";
import { validateRequest } from "@tablestack/lib/auth";
import {
  formatApiError,
  formatApiSuccess,
  withUnifiedApiHandler,
  withCache,
  getRedisClient,
  ServiceNamespace,
  Logger,
} from "@repo/shared";
import { reservationService } from "@tablestack/lib/reservation-service";

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
export const GET = withUnifiedApiHandler(
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
      const availableTables = await reservationService.getAvailableTables(
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

        // Build candidate slots concurrently instead of sequential awaits
        const candidateResults = await Promise.allSettled(
          offsets.map(async (offset) => {
            const suggestedTime = addMinutes(requestedDate, offset);
            const suggestedZonedTime = toZonedTime(suggestedTime, timezone);
            const suggestedTimeStr = format(suggestedZonedTime, "HH:mm", {
              timeZone: timezone,
            });

            const suggestedIsClosed = isOvernight
              ? suggestedTimeStr < openingTime && suggestedTimeStr > closingTime
              : suggestedTimeStr < openingTime ||
                suggestedTimeStr > closingTime;

            if (suggestedIsClosed) {
              return null;
            }

            const tables = await reservationService.getAvailableTables(
              targetRestaurantId,
              suggestedTime,
              partySize,
              duration,
            );
            if (tables.length === 0) return null;

            return {
              time: suggestedTime.toISOString(),
              availableTables: tables,
            };
          }),
        );

        for (const result of candidateResults) {
          if (result.status === "fulfilled" && result.value) {
            suggestedSlots.push(result.value);
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
      ttl: 60, // 60 second cache for availability (reduces DB load under high traffic)
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
);
