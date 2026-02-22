/**
 * OpenDeliver Dispatcher Service
 *
 * Real-time driver matching and order assignment.
 * Replaces mock Math.random() driver simulation with actual driver pool management.
 *
 * Features:
 * - Queries active drivers from Postgres by trust score and availability
 * - Atomic order assignment to prevent double-booking
 * - Real-time notifications via Ably
 * - Driver ranking by trust score, proximity, and acceptance rate
 */

import { db } from "@repo/database";
import { sql } from "drizzle-orm";
import { redis } from "./redis-client";
import { RealtimeService } from "@repo/shared";
import { randomUUID } from "crypto";

export interface Driver {
  id: string;
  clerk_id: string;
  full_name: string;
  email: string;
  phone?: string;
  trust_score: number;
  is_active: boolean;
  vehicle_type?: "bike" | "car" | "van" | "truck";
  current_lat?: number;
  current_lng?: number;
  accepted_orders?: number;
  completed_orders?: number;
}

export interface OrderIntent {
  orderId: string;
  fulfillmentId: string;
  pickupAddress: string;
  deliveryAddress: string;
  customerId: string;
  items: Array<{ name: string; quantity: number; weight?: number }>;
  priority: "standard" | "express" | "urgent";
  priceDetails?: { total: number };
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
 * Calculate required vehicle type based on order items
 */
function getRequiredVehicleType(items: OrderIntent["items"]): "bike" | "car" | "van" | "truck" {
  const totalWeight = items.reduce((sum, item) => sum + (item.weight || 0.5), 0);

  if (totalWeight > 50) return "truck";
  if (totalWeight > 20) return "van";
  if (totalWeight > 5) return "car";
  return "bike";
}

/**
 * Calculate driver score for ranking
 * Higher score = better match
 */
function calculateDriverScore(
  driver: Driver,
  requiredVehicle: string,
  pickupLat: number,
  pickupLng: number
): number {
  let score = 0;

  // Trust score weight (0-100)
  score += driver.trust_score * 0.4;

  // Vehicle compatibility (0-25)
  if (driver.vehicle_type === requiredVehicle) {
    score += 25;
  } else if (
    (requiredVehicle === "bike" && ["car", "van"].includes(driver.vehicle_type || "")) ||
    (requiredVehicle === "car" && ["van"].includes(driver.vehicle_type || ""))
  ) {
    score += 15; // Can upgrade vehicle
  }

  // Acceptance rate (0-25)
  if (driver.accepted_orders && driver.completed_orders) {
    const acceptanceRate = driver.completed_orders / driver.accepted_orders;
    score += acceptanceRate * 25;
  }

  // Proximity bonus (0-10) - simplified, in production use Haversine formula
  if (driver.current_lat && driver.current_lng) {
    const distance = Math.sqrt(
      Math.pow(driver.current_lat - pickupLat, 2) +
      Math.pow(driver.current_lng - pickupLng, 2)
    );
    // Closer drivers get higher score (max 10 points for < 1km)
    score += Math.max(0, 10 - distance * 10);
  }

  return score;
}

/**
 * Find available drivers for an order
 * Returns drivers sorted by match score
 */
export async function findAvailableDrivers(
  orderIntent: OrderIntent
): Promise<Array<Driver & { matchScore: number }>> {
  const requiredVehicle = getRequiredVehicleType(orderIntent.items);

  // Query active drivers from Postgres
  const driversResult = await db.execute(
    sql`
      SELECT
        id,
        clerk_id,
        full_name,
        email,
        phone,
        trust_score,
        is_active,
        vehicle_type,
        current_lat,
        current_lng,
        accepted_orders,
        completed_orders
      FROM drivers
      WHERE is_active = TRUE
        AND trust_score >= 50
      ORDER BY trust_score DESC
      LIMIT 20
    `
  );

  const drivers = driversResult.rows as any[];

  if (drivers.length === 0) {
    console.log(
      `[Dispatcher] No active drivers available for order ${orderIntent.orderId}`
    );
    return [];
  }

  // Calculate match scores
  // In production, you'd geocode the pickup address to get lat/lng
  const pickupLat = 40.7128; // Default to NYC
  const pickupLng = -74.0060;

  const scoredDrivers = drivers.map((driver) => ({
    ...driver,
    matchScore: calculateDriverScore(driver, requiredVehicle, pickupLat, pickupLng),
  }));

  // Sort by score descending
  scoredDrivers.sort((a, b) => b.matchScore - a.matchScore);

  console.log(
    `[Dispatcher] Found ${scoredDrivers.length} drivers for order ${orderIntent.orderId}, ` +
    `best match: ${scoredDrivers[0].full_name} (score: ${scoredDrivers[0].matchScore.toFixed(1)})`
  );

  return scoredDrivers;
}

/**
 * Atomically assign order to driver
 * Prevents double-booking via optimistic locking
 */
export async function assignOrderToDriver(
  orderId: string,
  driverId: string
): Promise<boolean> {
  try {
    const result = await db.execute(
      sql`
        UPDATE orders
        SET
          driver_id = ${driverId},
          status = 'matched',
          matched_at = NOW(),
          updated_at = NOW()
        WHERE
          id = ${orderId}
          AND status = 'pending'
          AND driver_id IS NULL
        RETURNING id
      `
    );

    const assigned = result.rows.length > 0;

    if (assigned) {
      console.log(`[Dispatcher] Order ${orderId} assigned to driver ${driverId}`);
    } else {
      console.log(
        `[Dispatcher] Failed to assign order ${orderId} to driver ${driverId} - order no longer available`
      );
    }

    return assigned;
  } catch (error) {
    console.error(`[Dispatcher] Error assigning order:`, error);
    return false;
  }
}

/**
 * Dispatch order to driver network
 * Main entry point for order matching
 */
export async function dispatchOrder(
  orderIntent: OrderIntent
): Promise<MatchResult> {
  const traceId = orderIntent.traceId || randomUUID();

  console.log(
    `[Dispatcher:${traceId}] Starting dispatch for order ${orderIntent.orderId}`
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
        })
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
      topDriver.id
    );

    if (!assigned) {
      // Order was taken by another driver or already matched
      // Try next available driver
      for (let i = 1; i < availableDrivers.length; i++) {
        const nextDriver = availableDrivers[i];
        const retryAssigned = await assignOrderToDriver(
          orderIntent.orderId,
          nextDriver.id
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
    console.error(
      `[Dispatcher:${traceId}] Error dispatching order:`,
      error instanceof Error ? error.message : error
    );

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

/**
 * Create match result with estimated times and broadcast to nervous system
 */
async function createMatchResult(
  orderIntent: OrderIntent,
  driver: Driver,
  traceId: string
): Promise<MatchResult> {
  const now = new Date();
  const estimatedArrival = new Date(now.getTime() + 10 * 60 * 1000); // 10 mins
  const estimatedPickup = new Date(now.getTime() + 15 * 60 * 1000); // 15 mins
  const estimatedDelivery = new Date(now.getTime() + 40 * 60 * 1000); // 40 mins

  const matchResult: MatchResult = {
    success: true,
    driver: {
      id: driver.id,
      clerk_id: driver.clerk_id,
      full_name: driver.full_name,
      email: driver.email,
      phone: driver.phone || "+1-555-0000",
      trust_score: driver.trust_score,
      is_active: driver.is_active,
      vehicle_type: driver.vehicle_type,
      current_lat: driver.current_lat,
      current_lng: driver.current_lng,
      accepted_orders: driver.accepted_orders,
      completed_orders: driver.completed_orders,
    },
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
    await RealtimeService.publish("nervous-system:updates", "order.matched", {
      orderId: orderIntent.orderId,
      fulfillmentId: orderIntent.fulfillmentId,
      driverId: driver.id,
      driverName: driver.full_name,
      driverEmail: driver.email,
      trustScore: driver.trust_score,
      vehicleType: driver.vehicle_type,
      status: "matched",
      matchedAt: now.toISOString(),
      estimatedArrival: estimatedArrival.toISOString(),
      estimatedPickup: estimatedPickup.toISOString(),
      estimatedDelivery: estimatedDelivery.toISOString(),
      traceId,
    });

    console.log(
      `[Dispatcher:${traceId}] Broadcast order.matched for ${orderIntent.orderId}`
    );
  } catch (error) {
    console.warn(
      `[Dispatcher:${traceId}] Failed to broadcast to Ably:`,
      error
    );
  }

  // Step 6: Send notification to matched driver (future: push notification)
  // For now, just log - in production, send SMS/push notification
  console.log(
    `[Dispatcher:${traceId}] Driver ${driver.full_name} (${driver.email}) matched to order ${orderIntent.orderId}`
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
        console.log(
          `[Dispatcher] Max retries reached for order ${orderIntent.orderId}, removing from queue`
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
        console.log(
          `[Dispatcher] Retry successful for order ${orderIntent.orderId} (attempt ${attemptCount})`
        );
      } else {
        // Update retry count in Redis
        await redis.setex(key, 300, JSON.stringify(orderIntent));
      }
    } catch (error) {
      console.error(`[Dispatcher] Error retrying dispatch for ${key}:`, error);
    }
  }

  return successfulRetries;
}
