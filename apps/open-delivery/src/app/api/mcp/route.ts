import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLS } from "@repo/mcp-protocol";
import {
  createMcpServerRoutes,
  createResponse,
} from "@repo/mcp-protocol/server";
import { randomUUID } from "crypto";
import { getDb, orders, orderItems } from "@repo/database";
import {
  RealtimeService,
  AppConfig,
  getRedisClient,
  ServiceNamespace,
  Logger,
} from "@repo/shared";
import { dispatchOrder } from "@open-delivery/lib/dispatcher";

const logger = new Logger({ serviceName: "open-delivery-mcp" });

// Lazy load Redis to avoid build-time initialization
let _redis: unknown = null;
const getRedis = async () => {
  if (!_redis) {
    _redis = getRedisClient(ServiceNamespace.OD);
  }
  return _redis;
};

// Create a singleton server instance
const server = new McpServer({
  name: "opendeliver-server",
  version: "0.1.0",
});

/**
 * Calculate delivery quote with detailed pricing breakdown
 */
async function calculateDeliveryQuote(
  pickupAddress: string,
  deliveryAddress: string,
  items: Array<Record<string, unknown>>,
  priority: string = "standard",
  traceId: string,
  restaurantId?: string,
) {
  logger.info("Calculating delivery quote", { traceId, restaurantId });

  // Phase D: Cross-Service "Context Injection"
  // Automatically pad delivery estimate if TableStack waitlist is long
  let waitlistPaddingMins = 0;
  let kitchenLoadLevel: "low" | "medium" | "high" = "low";

  if (restaurantId && process.env.TABLESTACK_API_URL) {
    try {
      // Vercel Hobby Tier Optimization: 8-second timeout with AbortController
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const waitlistRes = await fetch(
        `${AppConfig.getTableStackApiUrl()}/waitlist?restaurantId=${restaurantId}`,
        {
          headers: {
            "x-trace-id": traceId,
            Authorization: `Bearer ${AppConfig.getInternalSystemKey()}`,
          },
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (waitlistRes.ok) {
        const { waitlistCount } = await waitlistRes.json();

        // Deterministic Kitchen Load Buffer Logic:
        // - 0-5 parties: Normal operations (no buffer)
        // - 6-10 parties: Medium load (+10 min buffer)
        // - 11+ parties: High load (+20 min buffer)
        if (waitlistCount > 10) {
          waitlistPaddingMins = 20;
          kitchenLoadLevel = "high";
          logger.info("HIGH kitchen load detected", {
            traceId,
            waitlistCount,
            bufferMinutes: 20,
          });
        } else if (waitlistCount > 5) {
          waitlistPaddingMins = 10;
          kitchenLoadLevel = "medium";
          logger.info("MEDIUM kitchen load detected", {
            traceId,
            waitlistCount,
            bufferMinutes: 10,
          });
        }
      }
    } catch (err) {
      logger.warn("Failed to fetch waitlist from TableStack", {
        traceId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Graceful degradation - continue without kitchen load data
    }
  }

  // Calculate base price
  const basePrice = 12.5;
  const itemBuffer = items.length * 0.5;
  const priorityMultiplier =
    priority === "express" ? 1.5 : priority === "urgent" ? 2.0 : 1.0;

  // Calculate distance-based fee (simplified - in real app use actual distance API)
  const distanceFee = 2.0; // Base distance fee

  // Calculate weight-based fee
  const totalWeight = items.reduce(
    (sum, item) => sum + (item.weight || 0.5),
    0,
  );
  const weightFee = totalWeight * 0.3;

  const subtotal =
    (basePrice + itemBuffer + distanceFee + weightFee) * priorityMultiplier;
  const total = Math.round(subtotal * 100) / 100;

  const basePickupMins =
    priority === "urgent" ? 10 : priority === "express" ? 15 : 20;
  const pickupMins = basePickupMins + waitlistPaddingMins;

  return {
    quoteId: randomUUID(),
    validUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min validity
    price: {
      base: basePrice,
      distance: distanceFee,
      weight: Math.round(weightFee * 100) / 100,
      priority:
        Math.round(
          (subtotal - (basePrice + itemBuffer + distanceFee + weightFee)) * 100,
        ) / 100,
      total,
      currency: "USD",
    },
    estimatedTime: {
      pickupMinutes: pickupMins,
      deliveryMinutes:
        25 + (items.length > 2 ? 10 : 0) + (priority === "urgent" ? -5 : 0),
      totalMinutes:
        pickupMins +
        (25 + (items.length > 2 ? 10 : 0) + (priority === "urgent" ? -5 : 0)),
    },
    availableVehicles: items.some(
      (i: Record<string, unknown>) => (i.weight || 0) > 10,
    )
      ? ["van", "truck"]
      : items.some((i: Record<string, unknown>) => (i.weight || 0) > 5)
        ? ["car", "van"]
        : ["bike", "car", "van"],
    route: {
      distanceKm: 3.5, // Simplified
      estimatedDurationMinutes: 15,
    },
    kitchenLoad: {
      level: kitchenLoadLevel,
      waitlistCount: kitchenLoadLevel !== "low" ? undefined : undefined, // Only included if relevant
      appliedBufferMinutes:
        waitlistPaddingMins > 0 ? waitlistPaddingMins : undefined,
    },
  };
}

// Legacy calculateQuote tool with traceId support
server.tool(
  TOOLS.openDelivery.calculateQuote.name,
  TOOLS.openDelivery.calculateQuote.description,
  TOOLS.openDelivery.calculateQuote.schema.shape,
  async (
    { pickup_address, delivery_address, items },
    _extra: { traceId?: string } | undefined,
  ) => {
    const traceId = _extra?.traceId || randomUUID();

    // pickup_address is a string in this legacy tool - no restaurantId extraction needed
    const quote = await calculateDeliveryQuote(
      pickup_address,
      delivery_address,
      items.map((name: string) => ({ name })),
      "standard",
      traceId,
      undefined, // restaurantId not available from string address
    );

    return createResponse(
      {
        ...quote,
        pickup_address,
        delivery_address,
        provider: "OpenDeliver-Standard",
      },
      traceId,
    );
  },
);

// Enhanced Delivery Quote tool with full feature set
server.tool(
  "calculate_delivery_quote",
  "Calculate a detailed delivery quote with pricing breakdown and vehicle options",
  {
    pickupAddress:
      TOOLS.deliveryFulfillment.calculateDeliveryQuote.schema.shape
        .pickupAddress,
    deliveryAddress:
      TOOLS.deliveryFulfillment.calculateDeliveryQuote.schema.shape
        .deliveryAddress,
    items: TOOLS.deliveryFulfillment.calculateDeliveryQuote.schema.shape.items,
    priority:
      TOOLS.deliveryFulfillment.calculateDeliveryQuote.schema.shape.priority,
    scheduledPickupTime:
      TOOLS.deliveryFulfillment.calculateDeliveryQuote.schema.shape
        .scheduledPickupTime,
    restaurantId:
      TOOLS.deliveryFulfillment.calculateDeliveryQuote.schema.shape
        .restaurantId,
  },
  async (
    {
      pickupAddress,
      deliveryAddress,
      items,
      priority,
      scheduledPickupTime: _scheduledPickupTime,
      restaurantId,
    },
    _extra: { traceId?: string } | undefined,
  ) => {
    const traceId = _extra?.traceId || randomUUID();

    const quote = await calculateDeliveryQuote(
      pickupAddress,
      deliveryAddress,
      items,
      priority,
      traceId,
      restaurantId,
    );

    return createResponse(quote, traceId);
  },
);

// DRY RUN: Validate fulfillment without dispatching
server.tool(
  "validate_fulfillment",
  "Validate a fulfillment without dispatching (dry run)",
  {
    pickupAddress:
      TOOLS.deliveryFulfillment.validateFulfillment.schema.shape.pickupAddress,
    deliveryAddress:
      TOOLS.deliveryFulfillment.validateFulfillment.schema.shape
        .deliveryAddress,
    items: TOOLS.deliveryFulfillment.validateFulfillment.schema.shape.items,
    priority:
      TOOLS.deliveryFulfillment.validateFulfillment.schema.shape.priority,
  },
  async (
    { pickupAddress, deliveryAddress, items, priority: _priority },
    _extra: { traceId?: string } | undefined,
  ) => {
    const traceId = _extra?.traceId || randomUUID();

    logger.info("Validating fulfillment (dry run)", { traceId });

    // Basic validation
    const errors: Array<{ field: string; message: string; code: string }> = [];

    if (!pickupAddress.street || !pickupAddress.city) {
      errors.push({
        field: "pickupAddress",
        message: "Invalid pickup address",
        code: "INVALID_ADDRESS",
      });
    }

    if (!deliveryAddress.street || !deliveryAddress.city) {
      errors.push({
        field: "deliveryAddress",
        message: "Invalid delivery address",
        code: "INVALID_ADDRESS",
      });
    }

    if (items.length === 0) {
      errors.push({
        field: "items",
        message: "At least one item required",
        code: "NO_ITEMS",
      });
    }

    const valid = errors.length === 0;

    return createResponse(
      {
        valid,
        errors: errors.length > 0 ? errors : undefined,
        warnings:
          items.length > 5
            ? ["Large order - may require multiple trips"]
            : undefined,
        estimatedAvailability: valid
          ? {
              vehicleTypes: items.some(
                (i: Record<string, unknown>) => (i.weight || 0) > 10,
              )
                ? ["van", "truck"]
                : ["bike", "car", "van"],
              earliestPickup: new Date(
                Date.now() + 10 * 60 * 1000,
              ).toISOString(),
              estimatedDelivery: new Date(
                Date.now() + 40 * 60 * 1000,
              ).toISOString(),
            }
          : undefined,
      },
      traceId,
    );
  },
);

// Intent Fulfillment - Dispatch to driver network
server.tool(
  "fulfill_intent",
  "Dispatch a delivery intent to the driver network",
  {
    quoteId: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.quoteId,
    customerId: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.customerId,
    customerName:
      TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.customerName,
    customerPhone:
      TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.customerPhone,
    pickupAddress:
      TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.pickupAddress,
    deliveryAddress:
      TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.deliveryAddress,
    items: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.items,
    priceDetails:
      TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.priceDetails,
    priority: TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.priority,
    specialInstructions:
      TOOLS.deliveryFulfillment.fulfillIntent.schema.shape.specialInstructions,
  },
  async (params, _extra: { traceId?: string } | undefined) => {
    const traceId = _extra?.traceId || randomUUID();

    logger.info("Dispatching intent fulfillment", { traceId });

    // Generate fulfillment ID
    const fulfillmentId = randomUUID();
    const orderId = randomUUID();

    // Format addresses
    const pickupAddressStr =
      typeof params.pickupAddress === "object"
        ? `${params.pickupAddress.street}, ${params.pickupAddress.city}, ${params.pickupAddress.state || ""} ${params.pickupAddress.zipCode || ""}`.trim()
        : params.pickupAddress;

    const deliveryAddressStr =
      typeof params.deliveryAddress === "object"
        ? `${params.deliveryAddress.street}, ${params.deliveryAddress.city}, ${params.deliveryAddress.state || ""} ${params.deliveryAddress.zipCode || ""}`.trim()
        : params.deliveryAddress;

    // 1. Write to Postgres (Durable storage)
    try {
      await getDb()
        .insert(orders)
        .values({
          id: orderId,
          userId: params.customerId,
          status: "pending",
          total: params.priceDetails?.total || 0,
          deliveryAddress: deliveryAddressStr,
          pickupAddress: pickupAddressStr,
          specialInstructions: params.specialInstructions,
          priority: params.priority || "standard",
          createdAt: new Date(),
        });

      // Insert order items
      if (params.items && params.items.length > 0) {
        await getDb()
          .insert(orderItems)
          .values(
            params.items.map((item: Record<string, unknown>) => ({
              orderId,
              name: item.name,
              quantity: item.quantity || 1,
              price: item.price || 0,
              specialInstructions: item.specialInstructions,
            })),
          );
      }

      logger.info("Order created in Postgres", { traceId, orderId });
    } catch (error) {
      logger.error("Failed to create order in Postgres", {
        traceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return createResponse(
        {
          error: "Failed to create order",
          details: error instanceof Error ? error.message : "Unknown error",
        },
        traceId,
        true,
      );
    }

    // 2. Store in Redis for fast lookup (with 1-hour TTL)
    const fulfillmentData = {
      ...params,
      fulfillmentId,
      orderId,
      status: "pending",
      createdAt: new Date().toISOString(),
      traceId,
    };

    const redis = await getRedis();
    await redis.setex(
      `fulfillment:${fulfillmentId}`,
      3600,
      JSON.stringify(fulfillmentData),
    );
    await redis.setex(
      `opendeliver:intent:${orderId}`,
      3600,
      JSON.stringify(fulfillmentData),
    );
    await redis.lpush("opendeliver:public_intents", orderId);

    // 3. Broadcast to Ably Nervous System (Real-time driver notification)
    try {
      await RealtimeService.publish(
        "nervous-system:updates",
        "delivery.intent_created",
        {
          orderId,
          fulfillmentId,
          pickupAddress: pickupAddressStr,
          deliveryAddress: deliveryAddressStr,
          price: params.priceDetails?.total,
          priority: params.priority,
          items: params.items,
          timestamp: new Date().toISOString(),
          traceId,
        },
      );
      logger.info("Broadcast intent_created to Ably", { traceId });
    } catch (error) {
      logger.warn("Failed to broadcast to Ably", {
        traceId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Non-fatal - continue even if Ably fails
    }

    // 4. Dispatch to driver network using real dispatcher service
    // This queries active drivers from Postgres and assigns the best match
    const orderIntent: Parameters<typeof dispatchOrder>[0] = {
      orderId,
      fulfillmentId,
      pickupAddress: pickupAddressStr,
      deliveryAddress: deliveryAddressStr,
      customerId: params.customerId,
      items: params.items,
      priority: params.priority ? "urgent" : "standard",
      priceDetails: params.priceDetails,
      specialInstructions: params.specialInstructions,
      traceId,
    };

    // Dispatch asynchronously (don't block the response)
    // The dispatcher will update Redis and broadcast via Ably when matched
    dispatchOrder(orderIntent)
      .then((result) => {
        if (result.success) {
          logger.info("Driver matched for fulfillment", {
            traceId,
            fulfillmentId,
            driverName: result.driver?.fullName,
            trustScore: result.driver?.trustScore,
          });
        } else {
          logger.warn("No driver found for fulfillment", {
            traceId,
            fulfillmentId,
            error: result.error,
          });
        }
      })
      .catch((err) => {
        logger.error("Dispatch error", {
          traceId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

    return createResponse(
      {
        fulfillmentId,
        orderId,
        status: "pending",
        message: "Intent dispatched to driver network",
        estimatedTimes: {
          driverMatch: "Within 5 minutes",
          pickup: "15-20 minutes",
          delivery: "40-50 minutes",
        },
        tracking: {
          url: `${AppConfig.getStoresUrl()}/track/${orderId}`,
          code: orderId.slice(0, 8).toUpperCase(),
        },
      },
      traceId,
    );
  },
);

// Get Fulfillment Status
server.tool(
  "get_fulfillment_status",
  "Check the real-time status of a delivery fulfillment",
  {
    fulfillmentId:
      TOOLS.deliveryFulfillment.getFulfillmentStatus.schema.shape.fulfillmentId,
  },
  async ({ fulfillmentId }, _extra: { traceId?: string } | undefined) => {
    const traceId = _extra?.traceId || randomUUID();

    logger.info("Getting fulfillment status", { traceId, fulfillmentId });

    const redis = await getRedis();
    const data = await redis.get(`fulfillment:${fulfillmentId}`);

    if (!data) {
      return createResponse(
        {
          error: "Fulfillment not found",
          fulfillmentId,
        },
        traceId,
        true,
      );
    }

    const fulfillment = typeof data === "string" ? JSON.parse(data) : data;

    return createResponse(
      {
        fulfillmentId,
        orderId: fulfillment.orderId,
        status: fulfillment.status,
        driver: fulfillment.driver,
        route:
          fulfillment.status === "transit"
            ? {
                currentLeg: "to_delivery",
                progressPercent: 45,
                remainingDistanceKm: 2.1,
                remainingTimeMinutes: 12,
              }
            : undefined,
        events: [
          { timestamp: fulfillment.createdAt, event: "fulfillment_created" },
          ...(fulfillment.driver
            ? [
                {
                  timestamp: fulfillment.createdAt,
                  event: "driver_matched",
                  details: { driverId: fulfillment.driver.id },
                },
              ]
            : []),
        ],
        updatedAt: new Date().toISOString(),
      },
      traceId,
    );
  },
);

// Enhanced getDriverLocation with traceId
server.tool(
  TOOLS.openDelivery.getDriverLocation.name,
  TOOLS.openDelivery.getDriverLocation.description,
  TOOLS.openDelivery.getDriverLocation.schema.shape,
  async ({ order_id }, _extra: { traceId?: string } | undefined) => {
    const traceId = _extra?.traceId || randomUUID();

    logger.info("Getting driver location", { traceId, orderId: order_id });

    const intentKey = `opendeliver:intent:${order_id}`;
    const redis = await getRedis();
    const intent = await redis.get(intentKey);

    if (!intent) {
      return createResponse(
        {
          order_id,
          status: "not_found",
          error: "Order not found",
        },
        traceId,
        true,
      );
    }

    const fulfillmentData =
      typeof intent === "string" ? JSON.parse(intent) : intent;

    // If order has a driver assigned, return driver's last known location
    if (fulfillmentData.driver) {
      // In production, query driver's real-time location from Redis/Postgres
      // For now, use driver's registered location if available
      return createResponse(
        {
          order_id,
          status: fulfillmentData.status || "matched",
          driver: {
            id: fulfillmentData.driver.id,
            name:
              fulfillmentData.driver.full_name || fulfillmentData.driver.name,
            vehicleType:
              fulfillmentData.driver.vehicle_type ||
              fulfillmentData.driver.vehicleType,
            trustScore:
              fulfillmentData.driver.trust_score ||
              fulfillmentData.driver.trustScore,
          },
          location: {
            lat: fulfillmentData.driver.current_lat || 40.7128,
            lng: fulfillmentData.driver.current_lng || -74.006,
          },
          bearing: fulfillmentData.driver.bearing || 0,
          estimated_arrival_mins:
            fulfillmentData.driver.estimated_arrival_mins || 10,
        },
        traceId,
      );
    }

    // No driver assigned yet
    return createResponse(
      {
        order_id,
        status: "searching",
        message: "Looking for available drivers...",
      },
      traceId,
    );
  },
);

// Cancel Fulfillment
server.tool(
  "cancel_fulfillment",
  "Cancel an in-progress delivery fulfillment",
  {
    fulfillmentId:
      TOOLS.deliveryFulfillment.cancelFulfillment.schema.shape.fulfillmentId,
    reason: TOOLS.deliveryFulfillment.cancelFulfillment.schema.shape.reason,
    details: TOOLS.deliveryFulfillment.cancelFulfillment.schema.shape.details,
  },
  async (
    { fulfillmentId, reason, details },
    _extra: { traceId?: string } | undefined,
  ) => {
    const traceId = _extra?.traceId || randomUUID();

    logger.info("Cancelling fulfillment", { traceId, fulfillmentId });

    const redis = await getRedis();
    const data = await redis.get(`fulfillment:${fulfillmentId}`);

    if (!data) {
      return createResponse(
        {
          error: "Fulfillment not found",
          fulfillmentId,
        },
        traceId,
        true,
      );
    }

    const fulfillment = typeof data === "string" ? JSON.parse(data) : data;

    if (fulfillment.status === "delivered") {
      return createResponse(
        {
          error: "Cannot cancel - already delivered",
          fulfillmentId,
        },
        traceId,
        true,
      );
    }

    // Update status
    const cancelledData = {
      ...fulfillment,
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
      cancellationReason: reason,
      cancellationDetails: details,
    };

    await redis.setex(
      `fulfillment:${fulfillmentId}`,
      3600,
      JSON.stringify(cancelledData),
    );

    return createResponse(
      {
        fulfillmentId,
        orderId: fulfillment.orderId,
        status: "cancelled",
        message: "Fulfillment cancelled successfully",
        refundAmount: fulfillment.priceDetails?.total || 0,
      },
      traceId,
    );
  },
);

// Export standardized MCP routes using factory
export const { GET, POST } = createMcpServerRoutes(server);
