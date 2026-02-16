import { NextRequest, NextResponse } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { TOOLS } from "@repo/mcp-protocol";
import { redis } from "@/lib/redis-client";
import { SecurityProvider } from "@repo/auth";
import { randomUUID } from "crypto";

// Create a singleton server instance
const server = new McpServer({
  name: "opendeliver-server",
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

/**
 * Calculate delivery quote with detailed pricing breakdown
 */
async function calculateDeliveryQuote(
  pickupAddress: any,
  deliveryAddress: any,
  items: any[],
  priority: string = "standard",
  traceId: string
) {
  console.log(`[Trace:${traceId}] Calculating delivery quote`);
  
  // Calculate base price
  const basePrice = 12.50;
  const itemBuffer = items.length * 0.5;
  const priorityMultiplier = priority === "express" ? 1.5 : priority === "urgent" ? 2.0 : 1.0;
  
  // Calculate distance-based fee (simplified - in real app use actual distance API)
  const distanceFee = 2.0; // Base distance fee
  
  // Calculate weight-based fee
  const totalWeight = items.reduce((sum, item) => sum + (item.weight || 0.5), 0);
  const weightFee = totalWeight * 0.3;
  
  const subtotal = (basePrice + itemBuffer + distanceFee + weightFee) * priorityMultiplier;
  const total = Math.round(subtotal * 100) / 100;
  
  return {
    quoteId: randomUUID(),
    validUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min validity
    price: {
      base: basePrice,
      distance: distanceFee,
      weight: Math.round(weightFee * 100) / 100,
      priority: Math.round((subtotal - (basePrice + itemBuffer + distanceFee + weightFee)) * 100) / 100,
      total,
      currency: "USD",
    },
    estimatedTime: {
      pickupMinutes: priority === "urgent" ? 10 : priority === "express" ? 15 : 20,
      deliveryMinutes: 25 + (items.length > 2 ? 10 : 0) + (priority === "urgent" ? -5 : 0),
      totalMinutes: priority === "urgent" ? 30 : priority === "express" ? 40 : 45,
    },
    availableVehicles: items.some((i: any) => (i.weight || 0) > 10) ? ["van", "truck"] : 
                       items.some((i: any) => (i.weight || 0) > 5) ? ["car", "van"] : 
                       ["bike", "car", "van"],
    route: {
      distanceKm: 3.5, // Simplified
      estimatedDurationMinutes: 15,
    },
  };
}

// Legacy calculateQuote tool with traceId support
server.tool(
  TOOLS.openDelivery.calculateQuote.name,
  TOOLS.openDelivery.calculateQuote.description,
  TOOLS.openDelivery.calculateQuote.schema.shape,
  async ({ pickup_address, delivery_address, items }, _extra: any) => {
    const traceId = _extra?.traceId || randomUUID();
    
    const quote = await calculateDeliveryQuote(
      pickup_address,
      delivery_address,
      items.map((name: string) => ({ name })),
      "standard",
      traceId
    );
    
    return createResponse({
      ...quote,
      pickup_address,
      delivery_address,
      provider: "OpenDeliver-Standard",
    }, traceId);
  }
);

// Enhanced Delivery Quote tool with full feature set
server.tool(
  "calculate_delivery_quote",
  "Calculate a detailed delivery quote with pricing breakdown and vehicle options",
  {
    pickupAddress: TOOLS.deliveryFulfillment.calculateDeliveryQuote.schema.shape.pickupAddress,
    deliveryAddress: TOOLS.deliveryFulfillment.calculateDeliveryQuote.schema.shape.deliveryAddress,
    items: TOOLS.deliveryFulfillment.calculateDeliveryQuote.schema.shape.items,
    priority: TOOLS.deliveryFulfillment.calculateDeliveryQuote.schema.shape.priority,
    scheduledPickupTime: TOOLS.deliveryFulfillment.calculateDeliveryQuote.schema.shape.scheduledPickupTime,
  },
  async ({ pickupAddress, deliveryAddress, items, priority, scheduledPickupTime }, _extra: any) => {
    const traceId = _extra?.traceId || randomUUID();
    
    const quote = await calculateDeliveryQuote(
      pickupAddress,
      deliveryAddress,
      items,
      priority,
      traceId
    );
    
    return createResponse(quote, traceId);
  }
);

// DRY RUN: Validate fulfillment without dispatching
server.tool(
  "validate_fulfillment",
  "Validate a fulfillment without dispatching (dry run)",
  {
    pickupAddress: TOOLS.deliveryFulfillment.validateFulfillment.schema.shape.pickupAddress,
    deliveryAddress: TOOLS.deliveryFulfillment.validateFulfillment.schema.shape.deliveryAddress,
    items: TOOLS.deliveryFulfillment.validateFulfillment.schema.shape.items,
    priority: TOOLS.deliveryFulfillment.validateFulfillment.schema.shape.priority,
  },
  async ({ pickupAddress, deliveryAddress, items, priority }, _extra: any) => {
    const traceId = _extra?.traceId || randomUUID();
    
    console.log(`[Trace:${traceId}] Validating fulfillment (dry run)`);
    
    // Basic validation
    const errors: any[] = [];
    
    if (!pickupAddress.street || !pickupAddress.city) {
      errors.push({ field: "pickupAddress", message: "Invalid pickup address", code: "INVALID_ADDRESS" });
    }
    
    if (!deliveryAddress.street || !deliveryAddress.city) {
      errors.push({ field: "deliveryAddress", message: "Invalid delivery address", code: "INVALID_ADDRESS" });
    }
    
    if (items.length === 0) {
      errors.push({ field: "items", message: "At least one item required", code: "NO_ITEMS" });
    }
    
    const valid = errors.length === 0;
    
    return createResponse({
      valid,
      errors: errors.length > 0 ? errors : undefined,
      warnings: items.length > 5 ? ["Large order - may require multiple trips"] : undefined,
      estimatedAvailability: valid ? {
        vehicleTypes: items.some((i: any) => (i.weight || 0) > 10) ? ["van", "truck"] : ["bike", "car", "van"],
        earliestPickup: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        estimatedDelivery: new Date(Date.now() + 40 * 60 * 1000).toISOString(),
      } : undefined,
    }, traceId);
  }
);

// Intent Fulfillment - Dispatch to driver network
server.tool(
  "fulfill_intent",
  "Dispatch a delivery intent to the driver network",
  {
    quoteId: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.quoteId,
    customerId: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.customerId,
    customerName: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.customerName,
    customerPhone: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.customerPhone,
    pickupAddress: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.pickupAddress,
    deliveryAddress: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.deliveryAddress,
    items: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.items,
    priceDetails: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.priceDetails,
    priority: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.priority,
    specialInstructions: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.specialInstructions,
  },
  async (params, _extra: any) => {
    const traceId = _extra?.traceId || randomUUID();
    
    console.log(`[Trace:${traceId}] Dispatching intent fulfillment`);
    
    // Generate fulfillment ID
    const fulfillmentId = randomUUID();
    const orderId = randomUUID();
    
    // Store in Redis for tracking
    const fulfillmentData = {
      ...params,
      fulfillmentId,
      orderId,
      status: "searching",
      createdAt: new Date().toISOString(),
      traceId,
    };
    
    await redis.setex(`fulfillment:${fulfillmentId}`, 3600, JSON.stringify(fulfillmentData));
    await redis.setex(`opendeliver:intent:${orderId}`, 3600, JSON.stringify(fulfillmentData));
    
    // Simulate driver matching (async)
    setTimeout(async () => {
      const matchedData = {
        ...fulfillmentData,
        status: "matched",
        driver: {
          id: randomUUID(),
          name: "Driver " + Math.floor(Math.random() * 1000),
          phone: "+1-555-0" + Math.floor(Math.random() * 1000000),
          vehicleType: params.items.some((i: any) => (i.weight || 0) > 5) ? "van" : "car",
          rating: 4.5 + Math.random() * 0.5,
        },
        estimatedTimes: {
          driverArrival: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          pickup: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
          delivery: new Date(Date.now() + 40 * 60 * 1000).toISOString(),
        },
      };
      await redis.setex(`fulfillment:${fulfillmentId}`, 3600, JSON.stringify(matchedData));
      console.log(`[Trace:${traceId}] Driver matched for fulfillment ${fulfillmentId}`);
    }, 5000);
    
    return createResponse({
      fulfillmentId,
      orderId,
      status: "searching",
      message: "Intent dispatched to driver network",
      estimatedTimes: {
        driverMatch: "Within 5 minutes",
        pickup: "15-20 minutes",
        delivery: "40-50 minutes",
      },
      tracking: {
        url: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/track/${orderId}`,
        code: orderId.slice(0, 8).toUpperCase(),
      },
    }, traceId);
  }
);

// Get Fulfillment Status
server.tool(
  "get_fulfillment_status",
  "Check the real-time status of a delivery fulfillment",
  {
    fulfillmentId: TOOLS.deliveryFulfillment.getFulfillmentStatus.schema.shape.fulfillmentId,
  },
  async ({ fulfillmentId }, _extra: any) => {
    const traceId = _extra?.traceId || randomUUID();
    
    console.log(`[Trace:${traceId}] Getting fulfillment status for ${fulfillmentId}`);
    
    const data = await redis.get(`fulfillment:${fulfillmentId}`);
    
    if (!data) {
      return createResponse({
        error: "Fulfillment not found",
        fulfillmentId,
      }, traceId, true);
    }
    
    const fulfillment = typeof data === "string" ? JSON.parse(data) : data;
    
    return createResponse({
      fulfillmentId,
      orderId: fulfillment.orderId,
      status: fulfillment.status,
      driver: fulfillment.driver,
      route: fulfillment.status === "transit" ? {
        currentLeg: "to_delivery",
        progressPercent: 45,
        remainingDistanceKm: 2.1,
        remainingTimeMinutes: 12,
      } : undefined,
      events: [
        { timestamp: fulfillment.createdAt, event: "fulfillment_created" },
        ...(fulfillment.driver ? [{ timestamp: fulfillment.createdAt, event: "driver_matched", details: { driverId: fulfillment.driver.id } }] : []),
      ],
      updatedAt: new Date().toISOString(),
    }, traceId);
  }
);

// Enhanced getDriverLocation with traceId
server.tool(
  TOOLS.openDelivery.getDriverLocation.name,
  TOOLS.openDelivery.getDriverLocation.description,
  TOOLS.openDelivery.getDriverLocation.schema.shape,
  async ({ order_id }, _extra: any) => {
    const traceId = _extra?.traceId || randomUUID();
    
    console.log(`[Trace:${traceId}] Getting driver location for order ${order_id}`);
    
    const intentKey = `opendeliver:intent:${order_id}`;
    const intent = await redis.get(intentKey);

    return createResponse({
      order_id,
      status: intent ? "matched" : "searching",
      location: {
        lat: 40.7128 + (Math.random() - 0.5) * 0.01,
        lng: -74.0060 + (Math.random() - 0.5) * 0.01,
      },
      bearing: Math.floor(Math.random() * 360),
      estimated_arrival_mins: Math.floor(Math.random() * 15) + 5,
    }, traceId);
  }
);

// Cancel Fulfillment
server.tool(
  "cancel_fulfillment",
  "Cancel an in-progress delivery fulfillment",
  {
    fulfillmentId: TOOLS.deliveryFulfillment.cancelFulfillment.schema.shape.fulfillmentId,
    reason: TOOLS.deliveryFulfillment.cancelFulfillment.schema.shape.reason,
    details: TOOLS.deliveryFulfillment.cancelFulfillment.schema.shape.details,
  },
  async ({ fulfillmentId, reason, details }, _extra: any) => {
    const traceId = _extra?.traceId || randomUUID();
    
    console.log(`[Trace:${traceId}] Cancelling fulfillment ${fulfillmentId}`);
    
    const data = await redis.get(`fulfillment:${fulfillmentId}`);
    
    if (!data) {
      return createResponse({
        error: "Fulfillment not found",
        fulfillmentId,
      }, traceId, true);
    }
    
    const fulfillment = typeof data === "string" ? JSON.parse(data) : data;
    
    if (fulfillment.status === "delivered") {
      return createResponse({
        error: "Cannot cancel - already delivered",
        fulfillmentId,
      }, traceId, true);
    }
    
    // Update status
    const cancelledData = {
      ...fulfillment,
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
      cancellationReason: reason,
      cancellationDetails: details,
    };
    
    await redis.setex(`fulfillment:${fulfillmentId}`, 3600, JSON.stringify(cancelledData));
    
    return createResponse({
      fulfillmentId,
      orderId: fulfillment.orderId,
      status: "cancelled",
      message: "Fulfillment cancelled successfully",
      refundAmount: fulfillment.priceDetails?.total || 0,
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
