import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS } from "@repo/mcp-protocol";
import { getDb, restaurants, restaurantReservations, eq } from "@repo/database";
import { addMinutes, parseISO } from "date-fns";
import { toZonedTime, format } from "date-fns-tz";
import {
  createMcpServerRoutes,
  createResponse,
} from "@repo/mcp-protocol/server";
import { randomUUID } from "crypto";
import { Logger } from "@repo/shared";
import { reservationService } from "@tablestack/lib/reservation-service";

const logger = new Logger({ serviceName: "table-stack" });

// Create a singleton server instance
const server = new McpServer({
  name: "tablestack-server",
  version: "0.1.0",
});

// Existing getAvailability tool with traceId support
server.tool(
  TOOLS.tableStack.getAvailability.name,
  TOOLS.tableStack.getAvailability.description,
  TOOLS.tableStack.getAvailability.schema.shape,
  async ({ restaurantId, date, partySize }) => {
    const traceId = randomUUID();

    const restaurant = await getDb().query.restaurants.findFirst({
      where: eq(restaurants.id, restaurantId),
    });

    if (!restaurant) {
      return createResponse({ error: "Restaurant not found" }, traceId, true);
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
        .map((d: string) => d.trim().toLowerCase()) || [];

    if (!openDays.includes(dayOfWeek)) {
      return createResponse(
        {
          message: "Restaurant is closed on this day",
          availableTables: [],
        },
        traceId,
      );
    }

    const timeStr = format(restaurantTime, "HH:mm", { timeZone: timezone });
    if (
      timeStr < (restaurant.openingTime || "00:00") ||
      timeStr > (restaurant.closingTime || "23:59")
    ) {
      return createResponse(
        {
          message: "Restaurant is closed at this time",
          availableTables: [],
        },
        traceId,
      );
    }

    const duration = restaurant.defaultDurationMinutes || 90;
    const availableTables = await reservationService.getAvailableTables(
      restaurantId,
      requestedDate,
      partySize,
      duration,
    );

    const suggestedSlots: Array<{
      time: string;
      availableTables: unknown[];
    }> = [];
    if (availableTables.length === 0) {
      const offsets = [-30, 30, -60, 60];
      for (const offset of offsets) {
        const suggestedTime = addMinutes(requestedDate, offset);
        const suggestedZonedTime = toZonedTime(suggestedTime, timezone);
        const suggestedTimeStr = format(suggestedZonedTime, "HH:mm", {
          timeZone: timezone,
        });

        if (
          suggestedTimeStr < (restaurant.openingTime || "00:00") ||
          suggestedTimeStr > (restaurant.closingTime || "23:59")
        ) {
          continue;
        }

        const tables = await reservationService.getAvailableTables(
          restaurantId,
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

    return createResponse(
      {
        restaurantId,
        requestedTime: requestedDate.toISOString(),
        partySize,
        availableTables,
        suggestedSlots: suggestedSlots.length > 0 ? suggestedSlots : undefined,
      },
      traceId,
    );
  },
);

// Existing bookTable tool with traceId support
server.tool(
  TOOLS.tableStack.bookTable.name,
  TOOLS.tableStack.bookTable.description,
  TOOLS.tableStack.bookTable.schema.shape,
  async ({
    restaurantId,
    tableId,
    guestName,
    guestEmail,
    partySize,
    startTime,
  }) => {
    const traceId = randomUUID();

    const restaurant = await getDb().query.restaurants.findFirst({
      where: eq(restaurants.id, restaurantId),
    });

    if (!restaurant) {
      return createResponse({ error: "Restaurant not found" }, traceId, true);
    }

    const start = parseISO(startTime);
    const duration = restaurant.defaultDurationMinutes || 90;
    const end = addMinutes(start, duration);

    const isCombined = tableId.includes("+");
    const tableIds = isCombined ? tableId.split("+") : [tableId];

    const [newReservation] = await getDb()
      .insert(restaurantReservations)
      .values({
        restaurantId,
        tableId: isCombined ? null : tableId,
        combinedTableIds: isCombined ? tableIds : null,
        guestName,
        guestEmail,
        partySize,
        startTime: start,
        endTime: end,
        status: "confirmed",
        isVerified: true,
      })
      .returning();

    logger.info(`Created reservation for ${guestName}`, {
      reservationId: newReservation.id,
      guestName,
      traceId,
    });

    return createResponse(
      {
        status: "confirmed",
        message: "Reservation confirmed successfully",
        booking_id: newReservation.id,
      },
      traceId,
    );
  },
);

// Table Management Tools - DRY RUN Validation
server.tool(
  "validate_reservation",
  "Validate a reservation without creating it (dry run)",
  {
    restaurantId: TOOLS.tableStack.getAvailability.schema.shape.restaurantId,
    date: TOOLS.tableStack.getAvailability.schema.shape.date,
    partySize: TOOLS.tableStack.getAvailability.schema.shape.partySize,
  },
  async ({ restaurantId, date, partySize }) => {
    const traceId = randomUUID();

    const restaurant = await getDb().query.restaurants.findFirst({
      where: eq(restaurants.id, restaurantId),
    });

    if (!restaurant) {
      return createResponse(
        {
          valid: false,
          error: "Restaurant not found",
        },
        traceId,
        true,
      );
    }

    const requestedDate = parseISO(date);
    const duration = restaurant.defaultDurationMinutes || 90;
    const availableTables = await reservationService.getAvailableTables(
      restaurantId,
      requestedDate,
      partySize,
      duration,
    );

    const isValid = availableTables.length > 0;

    return createResponse(
      {
        valid: isValid,
        restaurantId,
        requestedTime: requestedDate.toISOString(),
        partySize,
        availableTables: isValid ? availableTables : undefined,
        message: isValid
          ? "Reservation is valid and can be created"
          : "No tables available for requested time and party size",
      },
      traceId,
    );
  },
);

// Operational State tool with traceId
const liveOperationalStateTool = TOOLS.tableStack.getLiveOperationalState;
server.tool(
  liveOperationalStateTool.name,
  "Retrieve real-time table status for a restaurant",
  { restaurant_id: TOOLS.tableStack.getAvailability.schema.shape.restaurantId },
  async ({ restaurant_id }) => {
    const traceId = randomUUID();
    const key = `state:${restaurant_id}:tables`;
    const { getRedisClient, ServiceNamespace } = await import("@repo/shared");
    const redis = getRedisClient(ServiceNamespace.TS);

    const liveData = await redis.hgetall(key);

    return createResponse(
      {
        restaurant_id,
        live_data: liveData || {},
        message: liveData
          ? "Live operational state retrieved successfully."
          : "No live data available.",
      },
      traceId,
    );
  },
);

// Export standardized MCP routes using factory
export const { GET, POST } = createMcpServerRoutes(server);
