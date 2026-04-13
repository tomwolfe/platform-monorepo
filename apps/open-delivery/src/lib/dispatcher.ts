/**
 * OpenDeliver Dispatcher Service
 *
 * Real-time driver matching and order assignment.
 *
 * Architecture:
 * - Orchestration layer ONLY (DB calls, Redis, Ably notifications)
 * - Business logic (scoring, vehicle calculation, bounding box)
 *   delegated to pure functions in driver-scorer.ts
 *
 * Features:
 * - Queries active drivers from Postgres by trust score and availability
 * - Atomic order assignment to prevent double-booking
 * - Real-time notifications via Ably
 * - Driver ranking by trust score, proximity, and acceptance rate
 */

import {
  getDb,
  drivers as driversTable,
  orders as ordersTable,
  eq,
  and,
  gte,
  sql as drizzleSql,
  desc,
} from "@repo/database";
import { getRedisClient, ServiceNamespace, Logger } from "@repo/shared";
const redis = getRedisClient(ServiceNamespace.OD);
import { RealtimeService } from "@repo/shared";
import { geocode } from "@repo/shared/utils/geo";
import { randomUUID } from "crypto";
import {
  getRequiredVehicleType,
  calculateDriverScore,
  calculateBoundingBox,
  type Driver,
  type OrderItem,
} from "./driver-scorer";

const logger = new Logger({ serviceName: "open-delivery" });

// Re-export types for backward compatibility
export type { Driver, OrderItem } from "./driver-scorer";

export interface OrderIntent {
  orderId: string;
  fulfillmentId: string;
  pickupAddress: string;
  deliveryAddress: string;
  customerId: string;
  items: OrderItem[];
  priority: "standard" | "express" | "urgent";
  // CRYPTO PAYMENT SUPPORT - priceDetails now uses strings for token amounts
  priceDetails?: {
    total: number | string; // Can be fiat (number) or crypto smallest units (string)
    basePay?: number | string;
    tip?: number | string;
    currency?: string; // Token symbol (USDC, ETH, etc.)
    decimals?: number; // Token decimals
  };
  specialInstructions?: string;
  traceId?: string;
}

export interface MatchResult {
  success: boolean;
  driver?: Driver;
  orderId: string;
  fulfillmentId: string;
  matchedAt: string;
  estimatedArrival?: string;
  estimatedPickup?: string;
  estimatedDelivery?: string;
  error?: string;
}

/**
 * Find available drivers for an order
 * Returns drivers sorted by match score
 */
export async function findAvailableDrivers(
  orderIntent: OrderIntent,
): Promise<Array<Driver & { matchScore: number }>> {
  const requiredVehicle = getRequiredVehicleType(orderIntent.items);

  // Get database connection
  const database = getDb();

  // Geocode the pickup address to get lat/lng
  // CRITICAL: If geocoding fails, we CANNOT proceed with driver matching
  // Using incorrect coordinates would dispatch wrong drivers to wrong locations
  let pickupLat: number | null = null;
  let pickupLng: number | null = null;

  try {
    const geocodeResult = await geocode(orderIntent.pickupAddress);
    if (geocodeResult.success && geocodeResult.result) {
      pickupLat = geocodeResult.result.lat;
      pickupLng = geocodeResult.result.lng;
      logger.info(
        `[Dispatcher] Geocoded pickup address "${orderIntent.pickupAddress}" to (${pickupLat}, ${pickupLng})`,
      );
    } else {
      // Geocoding failed - return empty array, do NOT use fallback coordinates
      logger.error(
        `[Dispatcher] Geocoding failed for "${orderIntent.pickupAddress}": ${geocodeResult.error}. Cannot match drivers without valid coordinates.`,
        {
          details: {
            orderId: orderIntent.orderId,
            fulfillmentId: orderIntent.fulfillmentId,
          },
        },
      );
      return [];
    }
  } catch (error) {
    // Geocoding error - return empty array, do NOT use fallback coordinates
    logger.error(
      `[Dispatcher] Geocoding error for "${orderIntent.pickupAddress}"`,
      {
        error: error instanceof Error ? error.message : String(error),
        details: {
          orderId: orderIntent.orderId,
          fulfillmentId: orderIntent.fulfillmentId,
        },
      },
    );
    return [];
  }

  // BOUNDING BOX OPTIMIZATION: Filter drivers by proximity BEFORE fetching
  // Uses pure function from driver-scorer.ts
  const searchRadiusKm = 50; // Search within 50km radius
  const bbox = calculateBoundingBox(pickupLat!, pickupLng!, searchRadiusKm);
  const { minLat, maxLat, minLng, maxLng } = bbox;

  // Query active drivers from Postgres using Drizzle ORM with bounding box filter
  const drivers = await database
    .select()
    .from(driversTable)
    .where(
      and(
        eq(driversTable.isActive, true),
        gte(driversTable.trustScore, 50),
        // Bounding box filter: only fetch drivers within search radius
        drizzleSql`${driversTable.currentLat} IS NOT NULL`,
        drizzleSql`${driversTable.currentLng} IS NOT NULL`,
        gte(driversTable.currentLat, minLat),
        drizzleSql`${driversTable.currentLat}::numeric <= ${maxLat}`,
        gte(driversTable.currentLng, minLng),
        drizzleSql`${driversTable.currentLng}::numeric <= ${maxLng}`,
      ),
    )
    .orderBy(desc(driversTable.trustScore))
    .limit(20);

  if (drivers.length === 0) {
    logger.info(
      `[Dispatcher] No active drivers available for order ${orderIntent.orderId}`,
    );
    return [];
  }

  // Calculate match scores with validated coordinates
  const scoredDrivers = drivers.map((driver: (typeof drivers)[number]) => ({
    ...driver,
    matchScore: calculateDriverScore(
      driver,
      requiredVehicle,
      pickupLat!,
      pickupLng!,
    ),
  }));

  // Sort by score descending
  scoredDrivers.sort(
    (a: { matchScore: number }, b: { matchScore: number }) =>
      b.matchScore - a.matchScore,
  );

  logger.info(
    `[Dispatcher] Found ${scoredDrivers.length} drivers for order ${orderIntent.orderId}`,
    {
      details: {
        bestMatch: `${scoredDrivers[0].fullName} (score: ${scoredDrivers[0].matchScore.toFixed(1)})`,
      },
    },
  );

  return scoredDrivers;
}

/**
 * Atomically assign order to driver
 * Prevents double-booking via optimistic locking
 */
export async function assignOrderToDriver(
  orderId: string,
  driverId: string,
): Promise<boolean> {
  try {
    // Get database connection
    const database = getDb();

    // Use Drizzle ORM update with optimistic locking
    const result = await database
      .update(ordersTable)
      .set({
        driverId,
        status: "matched",
        matchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(ordersTable.id, orderId),
          eq(ordersTable.status, "pending"),
          // Optimistic locking: only update if driver_id is NULL
          eq(ordersTable.driverId, null),
        ),
      )
      .returning({ id: ordersTable.id });

    const assigned = result.length > 0;

    if (assigned) {
      logger.info(
        `[Dispatcher] Order ${orderId} assigned to driver ${driverId}`,
      );
    } else {
      logger.info(
        `[Dispatcher] Failed to assign order ${orderId} to driver ${driverId} - order no longer available`,
      );
    }

    return assigned;
  } catch (error) {
    logger.error("[Dispatcher] Error assigning order", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Dispatch order to driver network
 * Main entry point for order matching
 */
export async function dispatchOrder(
  orderIntent: OrderIntent,
): Promise<MatchResult> {
  const traceId = orderIntent.traceId || randomUUID();

  logger.info(
    `[Dispatcher:${traceId}] Starting dispatch for order ${orderIntent.orderId}`,
  );

  try {
    // Step 1: Find available drivers
    const availableDrivers = await findAvailableDrivers(orderIntent);

    if (availableDrivers.length === 0) {
      // No drivers available - store for later retry
      await redis.setex(
        `dispatch:pending:${orderIntent.orderId}`,
        300, // 5 minute TTL
        JSON.stringify({
          ...orderIntent,
          status: "no_drivers_available",
          retryCount: 0,
          lastAttempt: new Date().toISOString(),
        }),
      );

      return {
        success: false,
        orderId: orderIntent.orderId,
        fulfillmentId: orderIntent.fulfillmentId,
        matchedAt: new Date().toISOString(),
        error: "No drivers available in your area",
      };
    }

    // Step 2: Try to assign to top-ranked driver
    const topDriver = availableDrivers[0];

    const assigned = await assignOrderToDriver(
      orderIntent.orderId,
      topDriver.id,
    );

    if (!assigned) {
      // Order was taken by another driver or already matched
      // Try next available driver
      for (let i = 1; i < availableDrivers.length; i++) {
        const nextDriver = availableDrivers[i];
        const retryAssigned = await assignOrderToDriver(
          orderIntent.orderId,
          nextDriver.id,
        );

        if (retryAssigned) {
          return createMatchResult(orderIntent, nextDriver, traceId);
        }
      }

      return {
        success: false,
        orderId: orderIntent.orderId,
        fulfillmentId: orderIntent.fulfillmentId,
        matchedAt: new Date().toISOString(),
        error: "Order no longer available",
      };
    }

    // Step 3: Create match result and broadcast
    return createMatchResult(orderIntent, topDriver, traceId);
  } catch (error) {
    logger.error(`[Dispatcher:${traceId}] Error dispatching order`, {
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      orderId: orderIntent.orderId,
      fulfillmentId: orderIntent.fulfillmentId,
      matchedAt: new Date().toISOString(),
      error:
        error instanceof Error ? error.message : "Failed to dispatch order",
    };
  }
}
async function createMatchResult(
  orderIntent: OrderIntent,
  driver: Driver,
  traceId: string,
): Promise<MatchResult> {
  const now = new Date();
  const estimatedArrival = new Date(now.getTime() + 10 * 60 * 1000); // 10 mins
  const estimatedPickup = new Date(now.getTime() + 15 * 60 * 1000); // 15 mins
  const estimatedDelivery = new Date(now.getTime() + 40 * 60 * 1000); // 40 mins

  const matchResult: MatchResult = {
    success: true,
    driver,
    orderId: orderIntent.orderId,
    fulfillmentId: orderIntent.fulfillmentId,
    matchedAt: now.toISOString(),
    estimatedArrival: estimatedArrival.toISOString(),
    estimatedPickup: estimatedPickup.toISOString(),
    estimatedDelivery: estimatedDelivery.toISOString(),
  };

  // Step 4: Update Redis with match data
  const fulfillmentKey = `fulfillment:${orderIntent.fulfillmentId}`;
  const fulfillmentData = await redis.get<string>(fulfillmentKey);
  const updatedFulfillment = {
    ...(fulfillmentData ? JSON.parse(fulfillmentData) : {}),
    ...matchResult,
    status: "matched",
  };

  await redis.setex(fulfillmentKey, 3600, JSON.stringify(updatedFulfillment));

  // Step 5: Broadcast to Nervous System
  try {
    await RealtimeService.publish(
      "nervous-system:updates",
      "DeliveryDispatched",
      {
        orderId: orderIntent.orderId,
        fulfillmentId: orderIntent.fulfillmentId,
        driverId: driver.id,
        driverName: driver.fullName,
        driverEmail: driver.email,
        trustScore: driver.trustScore,
        vehicleType: driver.vehicleType,
        status: "matched",
        matchedAt: now.toISOString(),
        estimatedArrival: estimatedArrival.toISOString(),
        estimatedPickup: estimatedPickup.toISOString(),
        estimatedDelivery: estimatedDelivery.toISOString(),
        traceId,
      },
    );

    logger.info(
      `[Dispatcher:${traceId}] Broadcast DeliveryDispatched for ${orderIntent.orderId}`,
    );
  } catch (error) {
    logger.warn(`[Dispatcher:${traceId}] Failed to broadcast to Ably`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Step 6: Send notification to matched driver (future: push notification)
  // For now, just log - in production, send SMS/push notification
  logger.info(
    `[Dispatcher:${traceId}] Driver ${driver.fullName} (${driver.email}) matched to order ${orderIntent.orderId}`,
  );

  return matchResult;
}

/**
 * Retry pending dispatches
 * Called periodically to retry orders that had no drivers available
 */
export async function retryPendingDispatches(): Promise<number> {
  const pattern = "dispatch:pending:*";
  const keys = await redis.keys(pattern);

  let successfulRetries = 0;

  for (const key of keys) {
    try {
      const data = await redis.get<string>(key);
      if (!data) continue;

      const orderIntent = JSON.parse(data);
      const attemptCount = (orderIntent.retryCount || 0) + 1;

      // Max 3 retries
      if (attemptCount > 3) {
        await redis.del(key);
        logger.info(
          `[Dispatcher] Max retries reached for order ${orderIntent.orderId}, removing from queue`,
        );
        continue;
      }

      // Try dispatch again
      orderIntent.retryCount = attemptCount;
      orderIntent.lastAttempt = new Date().toISOString();

      const result = await dispatchOrder(orderIntent);

      if (result.success) {
        await redis.del(key);
        successfulRetries++;
        logger.info(
          `[Dispatcher] Retry successful for order ${orderIntent.orderId} (attempt ${attemptCount})`,
        );
      } else {
        // Update retry count in Redis
        await redis.setex(key, 300, JSON.stringify(orderIntent));
      }
    } catch (error) {
      logger.error(`[Dispatcher] Error retrying dispatch for ${key}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return successfulRetries;
}
