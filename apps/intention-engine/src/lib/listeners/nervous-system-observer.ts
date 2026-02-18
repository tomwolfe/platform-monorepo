/**
 * Nervous System Observer
 * 
 * Vercel Hobby Tier Optimization:
 * - Listens for SystemEvents from the event mesh (Ably)
 * - Proactively notifies users based on last_interaction_context
 * - Implements "Infinite Memory" feel using Postgres user context
 * 
 * Architecture:
 * 1. Subscribes to 'nervous-system:updates' channel
 * 2. Filters for TableVacated events
 * 3. Queries users.last_interaction_context for matching restaurant searches
 * 4. Sends proactive notification via Ably to user's channel
 */

import { getAblyClient, RealtimeService } from "@repo/shared";
import { db, eq, users, restaurants } from "@repo/database";
import { createSystemEvent, SystemEvent, createTypedSystemEvent } from "@repo/mcp-protocol";
import { signServiceToken } from "@repo/auth";

// ============================================================================
// OBSERVER CONFIGURATION
// ============================================================================

export interface ObserverConfig {
  /** Enable/disable proactive notifications */
  enableProactiveNotifications: boolean;
  /** Minimum confidence threshold for matching */
  matchConfidenceThreshold: number;
  /** Time window for considering context "fresh" (in hours) */
  contextFreshnessHours: number;
  /** Channel for publishing notifications */
  notificationChannel: string;
}

export const DEFAULT_OBSERVER_CONFIG: ObserverConfig = {
  enableProactiveNotifications: true,
  matchConfidenceThreshold: 0.6,
  contextFreshnessHours: 24,
  notificationChannel: "nervous-system:updates",
};

// ============================================================================
// TABLE VACATED EVENT PAYLOAD
// ============================================================================

export interface TableVacatedEvent {
  tableId: string;
  restaurantId: string;
  restaurantName?: string;
  restaurantSlug?: string;
  capacity?: number;
  timestamp: string;
  traceId?: string;
}

// ============================================================================
// USER CONTEXT MATCH
// Represents a matched user for proactive notification
// ============================================================================

export interface UserContextMatch {
  userId: string;
  userEmail: string;
  clerkId?: string;
  lastInteractionContext: {
    intentType?: string;
    rawText?: string;
    parameters?: Record<string, unknown>;
    timestamp?: string;
    executionId?: string;
    restaurantId?: string;
    restaurantSlug?: string;
    restaurantName?: string;
  };
  matchReason: string;
  confidence: number;
}

// ============================================================================
// NERVOUS SYSTEM OBSERVER
// ============================================================================

export class NervousSystemObserver {
  private config: ObserverConfig;
  private isSubscribed: boolean = false;

  constructor(config: Partial<ObserverConfig> = {}) {
    this.config = { ...DEFAULT_OBSERVER_CONFIG, ...config };
  }

  /**
   * Initialize the observer
   * In serverless environments, this is a no-op since we use pull-based approach
   */
  async initialize(): Promise<void> {
    if (!this.config.enableProactiveNotifications) {
      console.log("[NervousSystemObserver] Proactive notifications disabled");
      return;
    }

    // Serverless-friendly: No persistent subscriptions
    // Use processTableVacatedEvent for webhook-based triggers
    console.log("[NervousSystemObserver] Initialized (serverless mode)");
  }

  /**
   * Handle TableVacated event
   * Queries users with matching last_interaction_context
   */
  async handleTableVacated(eventData: {
    event: TableVacatedEvent;
    token: string;
  }): Promise<void> {
    const { event, token } = eventData;

    console.log(
      `[NervousSystemObserver] Processing TableVacated: ${event.tableId} at ${event.restaurantId}`
    );

    try {
      // Verify the event token
      const verified = await this.verifyEventToken(token);
      if (!verified) {
        console.warn("[NervousSystemObserver] Invalid event token, skipping");
        return;
      }

      // Find matching users
      const matchedUsers = await this.findMatchingUsers(event);

      if (matchedUsers.length === 0) {
        console.log("[NervousSystemObserver] No matching users found");
        return;
      }

      console.log(
        `[NervousSystemObserver] Found ${matchedUsers.length} matching users for proactive notification`
      );

      // Send proactive notifications
      for (const match of matchedUsers) {
        await this.sendProactiveNotification(match, event);
      }
    } catch (error) {
      console.error("[NervousSystemObserver] Error handling TableVacated:", error);
    }
  }

  /**
   * Find users with matching last_interaction_context
   */
  async findMatchingUsers(event: TableVacatedEvent): Promise<UserContextMatch[]> {
    try {
      // Get restaurant details
      const restaurant = await this.getRestaurantById(event.restaurantId);
      if (!restaurant) {
        console.warn(
          `[NervousSystemObserver] Restaurant not found: ${event.restaurantId}`
        );
        return [];
      }

      // Query users with relevant last_interaction_context
      // Note: In production, use more sophisticated querying or a search index
      const allUsers = await db.query.users.findMany({
        where: eq(users.role, "shopper"),
      });

      const matchedUsers: UserContextMatch[] = [];
      const now = new Date();

      for (const user of allUsers) {
        if (!user.lastInteractionContext) continue;

        const context = user.lastInteractionContext;
        const contextTime = context.timestamp ? new Date(context.timestamp) : null;

        // Check if context is fresh enough
        if (contextTime) {
          const hoursSinceInteraction =
            (now.getTime() - contextTime.getTime()) / (1000 * 60 * 60);
          if (hoursSinceInteraction > this.config.contextFreshnessHours) {
            continue;
          }
        }

        // Check for matching restaurant
        const matchResult = this.checkRestaurantMatch(
          context,
          restaurant,
          event
        );

        if (matchResult.confidence >= this.config.matchConfidenceThreshold) {
          matchedUsers.push({
            userId: user.id,
            userEmail: user.email,
            clerkId: user.clerkId || undefined,
            lastInteractionContext: context,
            matchReason: matchResult.reason,
            confidence: matchResult.confidence,
          });
        }
      }

      return matchedUsers;
    } catch (error) {
      console.error("[NervousSystemObserver] Error finding matching users:", error);
      return [];
    }
  }

  /**
   * Check if user's last_interaction_context matches the vacated table
   */
  private checkRestaurantMatch(
    context: NonNullable<typeof users.$inferSelect["lastInteractionContext"]>,
    restaurant: typeof restaurants.$inferSelect,
    event: TableVacatedEvent
  ): { confidence: number; reason: string } {
    let confidence = 0;
    const reasons: string[] = [];

    // Direct restaurant ID match (highest confidence)
    if ((context.parameters?.restaurantId as string) === event.restaurantId) {
      confidence += 0.5;
      reasons.push("Direct restaurant ID match");
    }

    // Restaurant name match (from raw text)
    if (
      context.rawText &&
      restaurant.name.toLowerCase().includes(context.rawText.toLowerCase())
    ) {
      confidence += 0.4;
      reasons.push("Restaurant name match in search");
    }

    // Intent type indicates reservation/search interest
    if (
      context.intentType &&
      ["SEARCH", "SCHEDULE", "ACTION"].includes(context.intentType)
    ) {
      confidence += 0.2;
      reasons.push(`Intent type: ${context.intentType}`);
    }

    // Party size context (if available)
    if (context.parameters?.partySize && event.capacity) {
      const partySize = context.parameters.partySize as number;
      if (event.capacity >= partySize) {
        confidence += 0.2;
        reasons.push(`Table capacity (${event.capacity}) matches party size (${partySize})`);
      }
    }

    return {
      confidence: Math.min(confidence, 1.0),
      reason: reasons.join("; "),
    };
  }

  /**
   * Send proactive notification to user
   */
  async sendProactiveNotification(
    user: UserContextMatch,
    event: TableVacatedEvent
  ): Promise<void> {
    try {
      const userChannel = `user:${user.clerkId || user.userId}`;

      // Build proactive message
      const notification = {
        type: "proactive_table_availability",
        title: "Table Available!",
        message: this.buildNotificationMessage(user, event),
        data: {
          tableId: event.tableId,
          restaurantId: event.restaurantId,
          restaurantName: event.restaurantName,
          capacity: event.capacity,
          timestamp: event.timestamp,
          matchReason: user.matchReason,
          confidence: user.confidence,
          suggestedAction: "Book this table now",
        },
        timestamp: new Date().toISOString(),
      };

      // Publish to user's channel
      await RealtimeService.publish(
        this.config.notificationChannel,
        "ProactiveNotification",
        notification,
        { traceId: event.traceId }
      );

      console.log(
        `[NervousSystemObserver] Sent proactive notification to ${user.userEmail}: ` +
        `${notification.message}`
      );

      // Also create a SystemEvent for audit trail
      const systemEvent = createTypedSystemEvent(
        "TableVacated",
        {
          tableId: event.tableId,
          restaurantId: event.restaurantId,
          notifiedUsers: [user.userId],
        } as any,
        "intention-engine",
        {
          traceId: event.traceId,
          metadata: {
            proactiveNotification: true,
            userEmail: user.userEmail,
          },
        }
      );

      // Log the event (could be stored in audit table)
      console.log(
        `[NervousSystemObserver] Created SystemEvent: ${systemEvent.id}`
      );
    } catch (error) {
      console.error(
        "[NervousSystemObserver] Error sending notification:",
        error
      );
    }
  }

  /**
   * Build human-readable notification message
   */
  private buildNotificationMessage(
    user: UserContextMatch,
    event: TableVacatedEvent
  ): string {
    const restaurantName = event.restaurantName || "the restaurant";
    const capacity = event.capacity ? ` (seats ${event.capacity})` : "";

    return `Good news! A table${capacity} just became available at ${restaurantName}. ` +
      `You recently searched for this restaurant - would you like to book it now?`;
  }

  /**
   * Get restaurant by ID or slug
   */
  private async getRestaurantById(
    restaurantId: string
  ): Promise<typeof restaurants.$inferSelect | null> {
    try {
      const restaurant = await db.query.restaurants.findFirst({
        where: eq(restaurants.id, restaurantId),
      });
      return restaurant || null;
    } catch (error) {
      console.error("[NervousSystemObserver] Error fetching restaurant:", error);
      return null;
    }
  }

  /**
   * Verify event token for security
   */
  private async verifyEventToken(token: string): Promise<boolean> {
    try {
      const { verifyServiceToken } = await import("@repo/auth");
      const verified = await verifyServiceToken(token);
      return !!verified;
    } catch (error) {
      console.error("[NervousSystemObserver] Token verification failed:", error);
      return false;
    }
  }

  /**
   * Manually trigger a check for a specific restaurant
   * Useful for testing or webhook-based triggers
   */
  async triggerRestaurantCheck(restaurantId: string): Promise<void> {
    const event: TableVacatedEvent = {
      tableId: "manual-trigger",
      restaurantId,
      timestamp: new Date().toISOString(),
    };

    await this.handleTableVacated({
      event,
      token: await signServiceToken({
        event: "TableVacated",
        data: event,
        timestamp: Date.now(),
      }),
    });
  }

  /**
   * Get observer status
   */
  getStatus(): {
    isSubscribed: boolean;
    config: ObserverConfig;
  } {
    return {
      isSubscribed: this.isSubscribed,
      config: this.config,
    };
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let observerInstance: NervousSystemObserver | null = null;

export function getNervousSystemObserver(
  config?: Partial<ObserverConfig>
): NervousSystemObserver {
  if (!observerInstance) {
    observerInstance = new NervousSystemObserver(config);
  }
  return observerInstance;
}

// ============================================================================
// SERVERLESS HELPER
// For use in API routes where subscription is per-request
// ============================================================================

export async function processTableVacatedEvent(
  eventData: { event: TableVacatedEvent; token: string },
  config?: Partial<ObserverConfig>
): Promise<void> {
  const observer = new NervousSystemObserver(config);
  await observer.handleTableVacated(eventData);
}
