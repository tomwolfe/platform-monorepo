import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { 
  CHECK_AVAILABILITY_TOOL,
  BOOK_RESERVATION_TOOL,
  DISCOVER_RESTAURANT_TOOL,
  TOOL_METADATA
} from "./tools.js";
import { db } from "../db/index.js";
import { restaurants, restaurantTables, reservations } from "../db/schema/index.js";
import { and, eq, gte, or, sql } from 'drizzle-orm';
import { addMinutes, parseISO } from 'date-fns';
import { toZonedTime, format } from 'date-fns-tz';

const server = new Server(
  {
    name: "tablestack-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

async function getAvailableTables(restaurantId: string, startTime: Date, partySize: number, duration: number) {
  const endTime = addMinutes(startTime, duration);

  const occupiedTableIdsResult = await db
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

  const occupiedTableIds = occupiedTableIdsResult.map(r => r.tableId).filter(Boolean) as string[];

  const occupiedCombinedTableIdsResult = await db
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

  occupiedCombinedTableIdsResult.forEach(r => {
    if (r.combinedTableIds) {
      occupiedTableIds.push(...(r.combinedTableIds as string[]));
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

  const vacantTables = allTables.filter(t => !occupiedTableIds.includes(t.id));
  const suggestedCombos: any[] = [];

  for (let i = 0; i < vacantTables.length; i++) {
    for (let j = i + 1; j < vacantTables.length; j++) {
      const t1 = vacantTables[i];
      const t2 = vacantTables[j];
      const combinedCapacity = t1.maxCapacity + t2.maxCapacity;
      
      if (combinedCapacity >= partySize) {
        const distance = Math.sqrt(
          Math.pow((t1.xPos || 0) - (t2.xPos || 0), 2) + 
          Math.pow((t1.yPos || 0) - (t2.yPos || 0), 2)
        );

        if (distance < 120) {
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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      CHECK_AVAILABILITY_TOOL,
      BOOK_RESERVATION_TOOL,
      DISCOVER_RESTAURANT_TOOL,
    ].map(tool => ({
      ...tool,
      annotations: {
        requires_confirmation: (TOOL_METADATA as any)[tool.name]?.requires_confirmation || false
      }
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "check_availability": {
        const { restaurantId, date, partySize } = args as any;
        
        const restaurant = await db.query.restaurants.findFirst({
          where: eq(restaurants.id, restaurantId),
        });

        if (!restaurant) {
          return { content: [{ type: "text", text: "Restaurant not found" }], isError: true };
        }

        const requestedDate = parseISO(date);
        const timezone = restaurant.timezone || 'UTC';
        const restaurantTime = toZonedTime(requestedDate, timezone);
        
        const dayOfWeek = format(restaurantTime, 'eeee', { timeZone: timezone }).toLowerCase();
        const openDays = restaurant.daysOpen?.split(',').map(d => d.trim().toLowerCase()) || [];
        
        if (!openDays.includes(dayOfWeek)) {
          return { content: [{ type: "text", text: JSON.stringify({ message: 'Restaurant is closed on this day', availableTables: [] }) }] };
        }

        const timeStr = format(restaurantTime, 'HH:mm', { timeZone: timezone });
        if (timeStr < (restaurant.openingTime || '00:00') || timeStr > (restaurant.closingTime || '23:59')) {
          return { content: [{ type: "text", text: JSON.stringify({ message: 'Restaurant is closed at this time', availableTables: [] }) }] };
        }

        const duration = restaurant.defaultDurationMinutes || 90;
        const availableTables = await getAvailableTables(restaurantId, requestedDate, partySize, duration);

        const suggestedSlots: any[] = [];
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

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              restaurantId,
              requestedTime: requestedDate.toISOString(),
              partySize,
              availableTables,
              suggestedSlots: suggestedSlots.length > 0 ? suggestedSlots : undefined,
            })
          }]
        };
      }

      case "book_tablestack_reservation": {
        const { restaurantId, tableId, guestName, guestEmail, partySize, startTime, is_confirmed } = args as any;

        if (!is_confirmed) {
          return {
            content: [{ type: "text", text: `CONFIRMATION_REQUIRED: Please confirm booking for ${guestName} at ${startTime} for ${partySize} guests.` }],
            isError: true
          };
        }

        const restaurant = await db.query.restaurants.findFirst({
          where: eq(restaurants.id, restaurantId),
        });

        if (!restaurant) {
          return { content: [{ type: "text", text: "Restaurant not found" }], isError: true };
        }

        const start = parseISO(startTime);
        const duration = restaurant.defaultDurationMinutes || 90;
        const end = addMinutes(start, duration);

        const isCombined = tableId.includes('+');
        const tableIds = isCombined ? tableId.split('+') : [tableId];

        const [newReservation] = await db.insert(reservations).values({
          restaurantId,
          tableId: isCombined ? null : tableId,
          combinedTableIds: isCombined ? tableIds : null,
          guestName,
          guestEmail,
          partySize,
          startTime: start,
          endTime: end,
          status: 'confirmed',
          isVerified: true, // Auto-verify for MCP calls?
        }).returning();

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "confirmed",
              message: "Reservation confirmed successfully",
              booking_id: newReservation.id,
            })
          }]
        };
      }

      case "discover_restaurant": {
        const { restaurant_slug } = args as any;
        
        const restaurant = await db.query.restaurants.findFirst({
          where: eq(restaurants.slug, restaurant_slug),
        });

        if (!restaurant) {
          return { content: [{ type: "text", text: "Restaurant not found" }], isError: true };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              restaurantId: restaurant.id,
              name: restaurant.name,
              slug: restaurant.slug,
              timezone: restaurant.timezone,
              openingTime: restaurant.openingTime,
              closingTime: restaurant.closingTime,
            })
          }]
        };
      }

      default:
        throw new Error(`Tool not found: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("TableStack MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
