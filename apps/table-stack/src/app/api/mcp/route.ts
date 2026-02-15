import { NextRequest, NextResponse } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { TOOLS } from "@repo/mcp-protocol";
import { db, restaurants, restaurantTables, restaurantReservations } from "@repo/database";
import { and, eq, gte, or, sql } from 'drizzle-orm';
import { addMinutes, parseISO } from 'date-fns';
import { toZonedTime, format } from 'date-fns-tz';
import { SecurityProvider } from "@repo/auth";
import { randomUUID } from "crypto";

// Create a singleton server instance
const server = new McpServer({
  name: "tablestack-server",
  version: "0.1.0",
});

/**
 * Extract trace ID from request headers or generate new one
 */
function extractTraceId(request: NextRequest): string {
  return request.headers.get("x-trace-id") || 
         request.headers.get("x-request-id") || 
         randomUUID();
}

/**
 * Create response with trace ID included
 */
function createResponse(data: any, traceId: string, isError = false) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ...data,
        traceId,
        timestamp: new Date().toISOString(),
      })
    }],
    isError,
  };
}

async function getAvailableTables(
  restaurantId: string, 
  startTime: Date, 
  partySize: number, 
  duration: number,
  traceId: string
) {
  console.log(`[Trace:${traceId}] Getting available tables for restaurant ${restaurantId}`);
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

// Existing getAvailability tool with traceId support
server.tool(
  TOOLS.tableStack.getAvailability.name,
  TOOLS.tableStack.getAvailability.description,
  TOOLS.tableStack.getAvailability.schema.shape,
  async ({ restaurantId, date, partySize }, _extra) => {
    const traceId = _extra?.traceId || randomUUID();
    
    const restaurant = await db.query.restaurants.findFirst({
      where: eq(restaurants.id, restaurantId),
    });

    if (!restaurant) {
      return createResponse({ error: "Restaurant not found" }, traceId, true);
    }

    const requestedDate = parseISO(date);
    const timezone = restaurant.timezone || 'UTC';
    const restaurantTime = toZonedTime(requestedDate, timezone);
    
    const dayOfWeek = format(restaurantTime, 'eeee', { timeZone: timezone }).toLowerCase();
    const openDays = restaurant.daysOpen?.split(',').map((d: string) => d.trim().toLowerCase()) || [];
    
    if (!openDays.includes(dayOfWeek)) {
      return createResponse({ 
        message: 'Restaurant is closed on this day', 
        availableTables: [] 
      }, traceId);
    }

    const timeStr = format(restaurantTime, 'HH:mm', { timeZone: timezone });
    if (timeStr < (restaurant.openingTime || '00:00') || timeStr > (restaurant.closingTime || '23:59')) {
      return createResponse({ 
        message: 'Restaurant is closed at this time', 
        availableTables: [] 
      }, traceId);
    }

    const duration = restaurant.defaultDurationMinutes || 90;
    const availableTables = await getAvailableTables(restaurantId, requestedDate, partySize, duration, traceId);

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

        const tables = await getAvailableTables(restaurantId, suggestedTime, partySize, duration, traceId);
        if (tables.length > 0) {
          suggestedSlots.push({
            time: suggestedTime.toISOString(),
            availableTables: tables,
          });
        }
      }
    }

    return createResponse({
      restaurantId,
      requestedTime: requestedDate.toISOString(),
      partySize,
      availableTables,
      suggestedSlots: suggestedSlots.length > 0 ? suggestedSlots : undefined,
    }, traceId);
  }
);

// Existing bookTable tool with traceId support
server.tool(
  TOOLS.tableStack.bookTable.name,
  TOOLS.tableStack.bookTable.description,
  TOOLS.tableStack.bookTable.schema.shape,
  async ({ restaurantId, tableId, guestName, guestEmail, partySize, startTime }, _extra) => {
    const traceId = _extra?.traceId || randomUUID();
    
    const restaurant = await db.query.restaurants.findFirst({
      where: eq(restaurants.id, restaurantId),
    });

    if (!restaurant) {
      return createResponse({ error: "Restaurant not found" }, traceId, true);
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

    console.log(`[Trace:${traceId}] Created reservation ${newReservation.id} for ${guestName}`);

    return createResponse({
      status: "confirmed",
      message: "Reservation confirmed successfully",
      booking_id: newReservation.id,
    }, traceId);
  }
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
  async ({ restaurantId, date, partySize }, _extra) => {
    const traceId = _extra?.traceId || randomUUID();
    
    const restaurant = await db.query.restaurants.findFirst({
      where: eq(restaurants.id, restaurantId),
    });

    if (!restaurant) {
      return createResponse({ 
        valid: false, 
        error: "Restaurant not found" 
      }, traceId, true);
    }

    const requestedDate = parseISO(date);
    const duration = restaurant.defaultDurationMinutes || 90;
    const availableTables = await getAvailableTables(restaurantId, requestedDate, partySize, duration, traceId);

    const isValid = availableTables.length > 0;
    
    return createResponse({
      valid: isValid,
      restaurantId,
      requestedTime: requestedDate.toISOString(),
      partySize,
      availableTables: isValid ? availableTables : undefined,
      message: isValid 
        ? "Reservation is valid and can be created" 
        : "No tables available for requested time and party size",
    }, traceId);
  }
);

// Operational State tool with traceId
server.tool(
  (TOOLS.tableStack as any).getLiveOperationalState?.name || "get_live_operational_state",
  "Retrieve real-time table status for a restaurant",
  { restaurant_id: TOOLS.tableStack.getAvailability.schema.shape.restaurantId },
  async ({ restaurant_id }: any, _extra) => {
    const traceId = _extra?.traceId || randomUUID();
    const key = `state:${restaurant_id}:tables`;
    const { getRedisClient, ServiceNamespace } = await import("@repo/shared");
    const redis = getRedisClient(ServiceNamespace.TS);
    
    const liveData = await redis.hgetall(key);
    
    return createResponse({
      restaurant_id,
      live_data: liveData || {},
      message: liveData ? "Live operational state retrieved successfully." : "No live data available."
    }, traceId);
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

  const traceId = extractTraceId(request);
  console.log(`[Trace:${traceId}] MCP SSE connection established`);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  transport = new SSEServerTransport("/api/mcp", {
    write: (data: string) => writer.write(encoder.encode(data)),
    end: () => writer.close(),
  } as any);

  // Pass traceId to tool context
  (transport as any).traceId = traceId;

  await server.connect(transport);

  return new NextResponse(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Trace-Id': traceId,
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

  const traceId = extractTraceId(request);

  try {
    const body = await request.json();
    // Attach traceId to transport for tool execution context
    (transport as any).traceId = traceId;
    await (transport as any).handlePostRequest(request, NextResponse as any);
    
    return new NextResponse("OK", {
      headers: {
        'X-Trace-Id': traceId,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ 
      error: error.message,
      traceId,
    }, { 
      status: 500,
      headers: {
        'X-Trace-Id': traceId,
      },
    });
  }
}
