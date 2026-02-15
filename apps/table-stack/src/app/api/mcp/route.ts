import { NextRequest, NextResponse } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { TOOLS } from "@repo/mcp-protocol";
import { db, restaurants, restaurantTables, restaurantReservations } from "@repo/database";
import { and, eq, gte, or, sql } from 'drizzle-orm';
import { addMinutes, parseISO } from 'date-fns';
import { toZonedTime, format } from 'date-fns-tz';
import { SecurityProvider } from "@repo/auth";

// Create a singleton server instance
const server = new McpServer({
  name: "tablestack-server",
  version: "0.1.0",
});

async function getAvailableTables(restaurantId: string, startTime: Date, partySize: number, duration: number) {
  const endTime = addMinutes(startTime, duration);

  const occupiedTableIdsResult = await db
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
        sql`(${restaurantReservations.startTime}, ${restaurantReservations.endTime}) OVERLAPS (${startTime.toISOString()}::timestamptz, ${endTime.toISOString()}::timestamptz)`
      )
    );

  const occupiedTableIds = occupiedTableIdsResult.map((r: any) => r.tableId).filter(Boolean) as string[];

  const occupiedCombinedTableIdsResult = await db
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
        sql`(${restaurantReservations.startTime}, ${restaurantReservations.endTime}) OVERLAPS (${startTime.toISOString()}::timestamptz, ${endTime.toISOString()}::timestamptz)`
      )
    );

  occupiedCombinedTableIdsResult.forEach((r: any) => {
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

  const availableIndividualTables = allTables.filter((t: any) => 
    !occupiedTableIds.includes(t.id) && t.maxCapacity >= partySize
  );

  if (availableIndividualTables.length > 0) {
    return availableIndividualTables.map((t: any) => ({ ...t, isCombined: false }));
  }

  const vacantTables = allTables.filter((t: any) => !occupiedTableIds.includes(t.id));
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

server.tool(
  TOOLS.tableStack.getAvailability.name,
  TOOLS.tableStack.getAvailability.description,
  TOOLS.tableStack.getAvailability.schema.shape,
  async ({ restaurantId, date, partySize }) => {
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
    const openDays = restaurant.daysOpen?.split(',').map((d: string) => d.trim().toLowerCase()) || [];
    
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
);

server.tool(
  TOOLS.tableStack.bookTable.name,
  TOOLS.tableStack.bookTable.description,
  TOOLS.tableStack.bookTable.schema.shape,
  async ({ restaurantId, tableId, guestName, guestEmail, partySize, startTime }) => {
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

    const [newReservation] = await db.insert(restaurantReservations).values({
      restaurantId,
      tableId: isCombined ? null : tableId,
      combinedTableIds: isCombined ? tableIds : null,
      guestName,
      guestEmail,
      partySize,
      startTime: start,
      endTime: end,
      status: 'confirmed',
      isVerified: true,
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
);

server.tool(
  (TOOLS.tableStack as any).getLiveOperationalState.name,
  (TOOLS.tableStack as any).getLiveOperationalState.description,
  (TOOLS.tableStack as any).getLiveOperationalState.schema.shape,
  async ({ restaurant_id }: any) => {
    const key = `state:${restaurant_id}:tables`;
    const { getRedisClient } = await import("@repo/shared");
    const redis = getRedisClient("table-stack", "ts");
    
    const liveData = await redis.hgetall(key);
    
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          restaurant_id,
          live_data: liveData || {},
          message: liveData ? "Live operational state retrieved successfully." : "No live data available."
        })
      }]
    };
  }
);

// Manage active transports
let transport: SSEServerTransport | null = null;

async function validateRequest(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.split(" ")[1] || request.nextUrl.searchParams.get("token");
  const internalKey = request.nextUrl.searchParams.get("internal_key");
  
  if (token) {
    const payload = await SecurityProvider.verifyServiceToken(token);
    if (payload) return true;
  }

  if (internalKey && SecurityProvider.validateInternalKey(internalKey)) {
    return true;
  }

  return SecurityProvider.validateHeaders(request.headers);
}

export async function GET(request: NextRequest) {
  if (!(await validateRequest(request))) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  transport = new SSEServerTransport("/api/mcp", {
    write: (data: string) => writer.write(encoder.encode(data)),
    end: () => writer.close(),
  } as any);

  await server.connect(transport);

  return new NextResponse(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

export async function POST(request: NextRequest) {
  if (!(await validateRequest(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!transport) {
    return NextResponse.json({ error: "No active transport" }, { status: 400 });
  }

  try {
    const body = await request.json();
    await (transport as any).handlePostRequest(request, NextResponse as any);
    return new NextResponse("OK");
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
