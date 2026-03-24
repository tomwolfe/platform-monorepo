/**
 * Live Operational State Service
 *
 * Fetches live operational state from Redis cache and database.
 * Provides Zero-Latency Context by pre-injecting state into system prompts.
 *
 * Features:
 * - Pre-flight state injection for restaurant availability
 * - Failed booking detection and failover policy evaluation
 * - Delivery load state monitoring
 * - Hard constraint generation for LLM planning
 *
 * @package @repo/intention-engine
 * @since 1.0.0
 */

import { getRedisClient, ServiceNamespace } from "@repo/shared";
const redis = getRedisClient(ServiceNamespace.IE);;
import { FailoverPolicyEngine, type PolicyEvaluationContext } from "@repo/shared";

// ============================================================================
// TYPES
// ============================================================================

export interface RestaurantState {
  id: string;
  name: string;
  tableAvailability: "available" | "limited" | "full" | "unknown";
  waitlistCount?: number;
  nextAvailableSlot?: string;
  hasRecentFailures?: boolean;
}

export interface FailedBooking {
  restaurantId: string;
  restaurantName?: string;
  failureReason: string;
  failedAt: string;
}

export interface DeliveryLoadState {
  isHighLoad: boolean;
  avgWaitTimeMinutes: number;
  activeDrivers: number;
  pendingOrders: number;
  recommendedTipBoost: number;
}

export interface FailoverSuggestion {
  type: string;
  value: unknown;
  confidence: number;
  message?: string;
}

export interface LiveOperationalStateResult {
  restaurantStates?: RestaurantState[];
  failedBookings?: FailedBooking[];
  deliveryLoadState?: DeliveryLoadState;
  rawText?: string;
  hardConstraints?: string[];
  failoverSuggestions?: FailoverSuggestion[];
}

interface IntentContext {
  intentType?: string;
  partySize?: number;
  requestedTime?: string;
  restaurantId?: string;
}

interface UserLocation {
  lat: number;
  lng: number;
}

// ============================================================================
// LIVE OPERATIONAL STATE SERVICE
// ============================================================================

/**
 * Fetch live operational state from Redis cache and database
 *
 * Pre-Flight State Injection:
 * - Checks restaurant_state:{id} for table availability
 * - Checks failed_bookings:{restaurantId} for recent failures
 * - If restaurant is "full" or has recent failures, LLM will suggest alternatives
 * - This saves an entire round-trip tool call by preventing invalid plans
 *
 * Hard Constraints:
 * - Restaurants marked as "full" are excluded from planning
 * - Recent failures trigger failover policy evaluation
 * - Delivery alternatives are pre-computed and injected
 *
 * @param messages - Conversation messages to extract restaurant mentions
 * @param userLocation - Optional user location for context
 * @param intentContext - Optional intent context for failover policies
 * @returns Live operational state including restaurant states, failed bookings, and suggestions
 */
export async function fetchLiveOperationalState(
  messages: any[],
  userLocation?: UserLocation,
  intentContext?: IntentContext
): Promise<LiveOperationalStateResult> {
  try {
    // Extract restaurant mentions from conversation history
    const restaurantMentions = new Set<string>();

    for (const msg of messages) {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join(" ")
            : "";

      if (!content) continue;

      // Look for restaurant IDs, names, or slugs in the conversation
      // Pattern 1: Direct restaurant ID references
      const idMatches = content.match(/restaurant[:\s]+([a-zA-Z0-9-_]+)/gi);
      if (idMatches) {
        idMatches.forEach((m: string) => {
          const id = m.split(/[:\s]+/)[1];
          if (id) restaurantMentions.add(id);
        });
      }

      // Pattern 2: Common restaurant names (would need NLP in production)
      // For now, look for capitalized multi-word phrases that might be restaurant names
      const nameMatches = content.match(
        /at\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g
      );
      if (nameMatches) {
        nameMatches.forEach((m: string) => {
          const name = m.replace(/^at\s+/, "");
          if (name) restaurantMentions.add(name);
        });
      }
    }

    if (restaurantMentions.size === 0) {
      return { rawText: "No specific restaurants mentioned in conversation" };
    }

    console.log(
      `[LiveOperationalState] Fetching state for restaurants: ${Array.from(restaurantMentions).join(", ")}`
    );

    // Fetch state from Redis cache (populated by TableStack events)
    const restaurantStates: RestaurantState[] = [];
    const failedBookings: FailedBooking[] = [];

    for (const restaurantRef of restaurantMentions) {
      // Try to fetch from Redis cache
      // Key pattern: restaurant_state:{id|slug}
      const stateKey = `restaurant_state:${restaurantRef}`;
      const cachedState = await redis?.get<any>(stateKey);

      // Also check for failed bookings
      // Key pattern: failed_bookings:{restaurantId} - Redis Set with recent failures
      const failedBookingsKey = `failed_bookings:${restaurantRef}`;
      const recentFailures = await redis?.get<any[]>(failedBookingsKey);
      const hasRecentFailures =
        recentFailures !== null &&
        recentFailures !== undefined &&
        recentFailures.length > 0;

      if (cachedState) {
        restaurantStates.push({
          id: cachedState.id || restaurantRef,
          name: cachedState.name || restaurantRef,
          tableAvailability: cachedState.tableAvailability || "unknown",
          waitlistCount: cachedState.waitlistCount,
          nextAvailableSlot: cachedState.nextAvailableSlot,
          hasRecentFailures,
        });
      } else {
        // Fallback: Try to fetch from database directly
        try {
          const {
            db,
            eq,
            restaurants: restaurantsTable,
            restaurantTables,
          } = await import("@repo/database");
          const restaurant = await getDb().query.restaurants.findFirst({
            where: eq(restaurantsTable.slug, restaurantRef),
          });

          if (restaurant) {
            // Fetch table availability
            const tables = await getDb().query.restaurantTables.findMany({
              where: eq(restaurantTables.restaurantId, restaurant.id),
            });

            const availableTables = tables.filter(
              (t: any) => t.status === "available"
            ).length;
            const totalTables = tables.length;

            restaurantStates.push({
              id: restaurant.id,
              name: restaurant.name,
              tableAvailability:
                availableTables === 0
                  ? "full"
                  : availableTables < totalTables / 2
                    ? "limited"
                    : "available",
              nextAvailableSlot:
                availableTables === 0
                  ? "Unknown - try waitlist"
                  : undefined,
              hasRecentFailures,
            });

            // Also add to failed bookings if present
            if (hasRecentFailures && recentFailures) {
              for (const failure of recentFailures.slice(0, 3)) {
                failedBookings.push({
                  restaurantId: restaurant.id,
                  restaurantName: restaurant.name,
                  failureReason: failure.reason || "Booking failed",
                  failedAt: failure.timestamp || new Date().toISOString(),
                });
              }
            }
          }
        } catch (dbError) {
          console.warn(
            `[LiveOperationalState] Failed to fetch restaurant ${restaurantRef}:`,
            dbError
          );
        }
      }

      // Add failed bookings to result even if restaurant state not found
      if (hasRecentFailures && recentFailures) {
        for (const failure of recentFailures.slice(0, 3)) {
          failedBookings.push({
            restaurantId: restaurantRef,
            failureReason: failure.reason || "Booking failed",
            failedAt: failure.timestamp || new Date().toISOString(),
          });
        }
      }
    }

    // Generate hard constraints for the LLM
    const hardConstraints: string[] = [];
    const failoverSuggestions: FailoverSuggestion[] = [];

    // Hard constraint: Block full restaurants from planning
    const fullRestaurants = restaurantStates.filter(
      (r) => r.tableAvailability === "full"
    );
    if (fullRestaurants.length > 0) {
      hardConstraints.push(
        `CRITICAL: DO NOT attempt to book at these restaurants (they are full): ${fullRestaurants.map((r) => r.name).join(", ")}. ` +
          `Instead, suggest: (1) alternative times, (2) joining waitlist, or (3) delivery options.`
      );
    }

    // Hard constraint: Block restaurants with recent failures
    if (failedBookings && failedBookings.length > 0) {
      const failedRestaurantNames = failedBookings
        .map((f) => f.restaurantName || f.restaurantId)
        .filter((name, idx, arr) => arr.indexOf(name) === idx); // Unique

      hardConstraints.push(
        `CRITICAL: These restaurants have recent booking failures - DO NOT attempt booking: ${failedRestaurantNames.join(", ")}. ` +
          `Explain the issue to the user and offer alternatives immediately.`
      );
    }

    // Evaluate failover policies if we have failures and intent context
    if (
      (failedBookings?.length || fullRestaurants.length) &&
      intentContext
    ) {
      try {
        const policyEngine = new FailoverPolicyEngine();

        // Map intent type to policy format
        const policyIntentType =
          intentContext.intentType?.includes("BOOKING") ||
            intentContext.intentType?.includes("RESERVATION")
            ? "BOOKING"
            : intentContext.intentType?.includes("DELIVERY")
              ? "DELIVERY"
              : "BOOKING";

        const evalContext: PolicyEvaluationContext = {
          intent_type: policyIntentType,
          failure_reason:
            fullRestaurants.length > 0
              ? "RESTAURANT_FULL"
              : "VALIDATION_FAILED",
          confidence: 0.8,
          party_size: intentContext.partySize,
          requested_time: intentContext.requestedTime,
          restaurant_tags: intentContext.restaurantId
            ? [intentContext.restaurantId]
            : undefined,
        };

        const result = policyEngine.evaluate(evalContext);

        if (result.matched && result.recommended_action) {
          failoverSuggestions.push({
            type: result.recommended_action.type,
            value: result.recommended_action.parameters,
            confidence: result.confidence,
            message: result.recommended_action.message_template,
          });

          // Add specific suggestions based on action type
          if (
            result.recommended_action.type === "SUGGEST_ALTERNATIVE_TIME" &&
            intentContext.requestedTime
          ) {
            const offsets =
              (result.recommended_action.parameters
                ?.time_offset_minutes as number[]) || [-30, 30];
            const [hours, mins] = intentContext.requestedTime
              .split(":")
              .map(Number);
            const baseTotalMins = hours * 60 + mins;

            offsets.slice(0, 2).forEach((offset, idx) => {
              const newTotal = baseTotalMins + offset;
              if (newTotal >= 0 && newTotal < 24 * 60) {
                const newHours = Math.floor(newTotal / 60);
                const newMins = newTotal % 60;
                failoverSuggestions.push({
                  type: "alternative_time",
                  value: `${newHours.toString().padStart(2, "0")}:${newMins.toString().padStart(2, "0")}`,
                  confidence: 0.9 - idx * 0.1,
                  message: `How about ${newHours.toString().padStart(2, "0")}:${newMins.toString().padStart(2, "0")} instead?`,
                });
              }
            });
          }

          if (result.recommended_action.type === "TRIGGER_DELIVERY") {
            failoverSuggestions.push({
              type: "delivery_alternative",
              value: {
                estimated_time: "30-45 minutes",
                min_order:
                  (result.recommended_action.parameters?.min_order_amount as number) ||
                  1500,
              },
              confidence: 0.85,
              message:
                "Delivery is available from this restaurant in 30-45 minutes.",
            });
          }

          if (result.recommended_action.type === "TRIGGER_WAITLIST") {
            failoverSuggestions.push({
              type: "waitlist_alternative",
              value: {
                estimated_wait: "15-30 minutes",
                notification_method: "sms",
              },
              confidence: 0.75,
              message:
                "You can join the waitlist - current wait is approximately 15-30 minutes.",
            });
          }
        }
      } catch (policyError) {
        console.warn(
          "[FailoverPolicy] Failed to evaluate policies:",
          policyError
        );
        // Continue without failover suggestions
      }
    }

    // Check delivery load state for tip boost recommendations
    let deliveryLoadState: DeliveryLoadState | undefined;

    try {
      // Fetch pending orders count and active drivers from database
      const { db, sql, orders, drivers } = await import("@repo/database");

      const [pendingCountResult, activeDriversResult] = await Promise.all([
        db.execute(
          sql`SELECT COUNT(*) as count FROM orders WHERE status = 'pending' AND driver_id IS NULL`
        ),
        db.execute(
          sql`SELECT COUNT(*) as count FROM drivers WHERE is_active = true`
        ),
      ]);

      const pendingOrders = parseInt(
        (pendingCountResult.rows[0] as any)?.count || "0"
      );
      const activeDrivers = parseInt(
        (activeDriversResult.rows[0] as any)?.count || "0"
      );

      // Calculate load ratio and determine if high load
      const driverRatio =
        activeDrivers > 0 ? pendingOrders / activeDrivers : 999;
      const isHighLoad = driverRatio > 2 || pendingOrders > 10;

      // Calculate recommended tip boost based on load
      let recommendedTipBoost = 0;
      if (isHighLoad) {
        if (driverRatio > 5 || pendingOrders > 20) {
          recommendedTipBoost = 5; // High demand - suggest $5 boost
        } else if (driverRatio > 3 || pendingOrders > 15) {
          recommendedTipBoost = 3; // Medium demand - suggest $3 boost
        } else {
          recommendedTipBoost = 2; // Low demand - suggest $2 boost
        }
      }

      // Estimate wait time based on load
      const avgWaitTimeMinutes = isHighLoad
        ? Math.round(15 + driverRatio * 5)
        : 10;

      deliveryLoadState = {
        isHighLoad,
        avgWaitTimeMinutes,
        activeDrivers,
        pendingOrders,
        recommendedTipBoost,
      };

      // Add tip boost suggestion if high load
      if (
        isHighLoad &&
        intentContext?.intentType?.includes("DELIVERY")
      ) {
        failoverSuggestions.push({
          type: "tip_boost_recommendation",
          value: {
            current_load: "high",
            pending_orders: pendingOrders,
            active_drivers: activeDrivers,
            recommended_boost: recommendedTipBoost,
          },
          confidence: 0.85,
          message: `Drivers are in high demand right now. Increasing your tip by $${recommendedTipBoost} may attract a driver faster and reduce your wait time.`,
        });
      }
    } catch (error) {
      console.warn(
        "[DeliveryLoadState] Failed to fetch delivery load state:",
        error
      );
      // Continue without delivery load state
    }

    return {
      restaurantStates,
      failedBookings: failedBookings?.length ? failedBookings : undefined,
      deliveryLoadState,
      hardConstraints:
        hardConstraints.length > 0 ? hardConstraints : undefined,
      failoverSuggestions:
        failoverSuggestions.length > 0 ? failoverSuggestions : undefined,
    };
  } catch (error) {
    console.error(
      "[LiveOperationalState] Failed to fetch operational state:",
      error
    );
    return { rawText: "Unable to fetch live restaurant states" };
  }
}
