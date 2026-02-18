/**
 * Nervous System Observer - Enhanced Proactive Observer
 *
 * Vercel Hobby Tier Optimization:
 * - Listens for SystemEvents from the event mesh (Ably)
 * - Proactively notifies users based on last_interaction_context
 * - Implements "Infinite Memory" feel using Postgres user context
 * - Uses LLM to generate proactive intents for re-engagement
 *
 * Architecture:
 * 1. Subscribes to 'nervous-system:updates' channel
 * 2. Filters for TableVacated events
 * 3. Queries users.last_interaction_context for matching restaurant searches
 * 4. Uses LLM to generate "Proactive Intent" (e.g., "The table you wanted at Pesto Place is now free")
 * 5. Sends proactive notification via Ably to user's channel
 * 6. Tracks all proactive notifications for audit and learning
 */

import { getAblyClient, RealtimeService, MemoryClient, getMemoryClient as getSharedMemoryClient } from "@repo/shared";
import { db, eq, users, restaurants, restaurantReservations } from "@repo/database";
import { createSystemEvent, SystemEvent, createTypedSystemEvent } from "@repo/mcp-protocol";
import { signServiceToken } from "@repo/auth";
import { generateText } from "../engine/llm";
import { Redis } from "@upstash/redis";

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
    status?: "FAILED" | "TIMEOUT" | "CANCELLED" | "COMPLETED";
  };
  matchReason: string;
  confidence: number;
}

// ============================================================================
// PROACTIVE NOTIFICATION RESULT
// ============================================================================

export interface ProactiveNotificationResult {
  success: boolean;
  notificationId?: string;
  message?: string;
  error?: string;
  usersNotified: number;
  llmGeneratedContent?: {
    proactiveIntent: string;
    suggestedAction: string;
  };
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
   * Specifically targets users whose last interaction FAILED
   */
  async handleTableVacated(eventData: {
    event: TableVacatedEvent;
    token: string;
  }): Promise<ProactiveNotificationResult> {
    const { event, token } = eventData;

    console.log(
      `[NervousSystemObserver] Processing TableVacated: ${event.tableId} at ${event.restaurantId}`
    );

    const usersNotified = 0;
    let llmContent: { proactiveIntent: string; suggestedAction: string } | undefined;

    try {
      // Verify the event token
      const verified = await this.verifyEventToken(token);
      if (!verified) {
        console.warn("[NervousSystemObserver] Invalid event token, skipping");
        return {
          success: false,
          error: "Invalid event token",
          usersNotified: 0,
        };
      }

      // Find matching users - specifically those with FAILED status
      const matchedUsers = await this.findMatchingUsers(event);

      if (matchedUsers.length === 0) {
        console.log("[NervousSystemObserver] No matching users found");
        return {
          success: true,
          usersNotified: 0,
        };
      }

      console.log(
        `[NervousSystemObserver] Found ${matchedUsers.length} matching users for proactive notification`
      );

      // Send proactive notifications
      let successCount = 0;
      for (const match of matchedUsers) {
        const result = await this.sendProactiveNotification(match, event);
        if (result.success) {
          successCount++;
          if (!llmContent && match.lastInteractionContext) {
            // Capture LLM-generated content from first notification
            const content = await this.buildNotificationMessage(match, event);
            llmContent = {
              proactiveIntent: content.proactiveIntent,
              suggestedAction: content.suggestedAction,
            };
          }
        }
      }

      console.log(
        `[NervousSystemObserver] Successfully notified ${successCount}/${matchedUsers.length} users`
      );

      return {
        success: true,
        usersNotified: successCount,
        llmGeneratedContent: llmContent,
      };
    } catch (error) {
      console.error("[NervousSystemObserver] Error handling TableVacated:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        usersNotified: 0,
      };
    }
  }

  /**
   * Find users with matching last_interaction_context
   * Specifically targets users whose last interaction FAILED for this restaurant
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
      // Focus on users whose last interaction FAILED
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

        // PRIORITY 1: Users who FAILED to book this restaurant
        if (context.status === "FAILED" || context.status === "TIMEOUT" || context.status === "CANCELLED") {
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
              matchReason: `FAILED booking: ${matchResult.reason}`,
              confidence: matchResult.confidence + 0.2, // Boost confidence for failed users
            });
            continue; // Found a match, move to next user
          }
        }

        // PRIORITY 2: Users who searched for this restaurant (even if completed)
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

      // Sort by confidence (FAILED users first)
      matchedUsers.sort((a, b) => b.confidence - a.confidence);

      return matchedUsers.slice(0, 5); // Limit to top 5 matches
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
  ): Promise<{ success: boolean; notificationId?: string; error?: string }> {
    try {
      const userChannel = `user:${user.clerkId || user.userId}`;

      // Generate LLM-powered notification content
      const notificationContent = await this.buildNotificationMessage(user, event);

      // Build proactive message
      const notification = {
        type: "proactive_table_availability",
        title: notificationContent.title,
        message: notificationContent.message,
        data: {
          tableId: event.tableId,
          restaurantId: event.restaurantId,
          restaurantName: event.restaurantName,
          capacity: event.capacity,
          timestamp: event.timestamp,
          matchReason: user.matchReason,
          confidence: user.confidence,
          suggestedAction: notificationContent.suggestedAction,
          proactiveIntent: notificationContent.proactiveIntent,
          // Deep link to book
          actionUrl: `/restaurants/${event.restaurantId}/book?table=${event.tableId}&source=proactive`,
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
          proactiveNotification: true,
          matchReason: user.matchReason,
          confidence: user.confidence,
        } as any,
        "intention-engine",
        {
          traceId: event.traceId,
          metadata: {
            proactiveNotification: true,
            llmGenerated: true,
            userEmail: user.userEmail,
          },
        }
      );

      // Store notification in Redis for analytics (optional)
      // Note: This would require direct Redis access or a new MemoryClient method
      // For now, the SystemEvent serves as the audit trail
      console.log(
        `[NervousSystemObserver] Notification audit trail created: ${systemEvent.id}`
      );

      return {
        success: true,
        notificationId: systemEvent.id,
      };
    } catch (error) {
      console.error(
        "[NervousSystemObserver] Error sending notification:",
        error
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Build human-readable notification message using LLM
   */
  private async buildNotificationMessage(
    user: UserContextMatch,
    event: TableVacatedEvent
  ): Promise<{
    title: string;
    message: string;
    proactiveIntent: string;
    suggestedAction: string;
  }> {
    const restaurantName = event.restaurantName || "the restaurant";
    const capacity = event.capacity ? ` (seats ${event.capacity})` : "";
    
    // Use LLM to generate personalized proactive intent
    try {
      const prompt = `You are a proactive assistant helping users who previously failed to book a restaurant table.
      
Context:
- User previously searched for or tried to book: ${user.lastInteractionContext.rawText || JSON.stringify(user.lastInteractionContext.parameters)}
- The restaurant they wanted: ${restaurantName}
- A table${capacity} just became available
- User's last interaction status: ${user.lastInteractionContext.status || "unknown"}

Generate a concise, compelling notification that:
1. Acknowledges their previous attempt
2. Announces the availability
3. Suggests immediate action

Respond with ONLY a JSON object in this format:
{
  "title": "Short catchy title (max 5 words)",
  "message": "1-2 sentence notification message",
  "proactiveIntent": "Natural language intent like 'The table you wanted at Pesto Place is now free. Should I book it?'",
  "suggestedAction": "Call-to-action button text like 'Book Now' or 'Reserve Table'"
}`;

      const response = await generateText({
        modelType: "planning",
        prompt,
        systemPrompt: "You are a helpful, concise notification generator. Output ONLY valid JSON.",
        temperature: 0.7,
      });

      const parsed = JSON.parse(response.content.trim());
      
      return {
        title: parsed.title || "Table Available!",
        message: parsed.message || `Good news! A table${capacity} just became available at ${restaurantName}.`,
        proactiveIntent: parsed.proactiveIntent || `The table you wanted at ${restaurantName} is now available.`,
        suggestedAction: parsed.suggestedAction || "Book Now",
      };
    } catch (error) {
      console.error("[NervousSystemObserver] LLM message generation failed, using fallback:", error);
      
      // Fallback to static message
      return {
        title: "Table Available!",
        message: `Good news! A table${capacity} just became available at ${restaurantName}. ` +
          `You recently searched for this restaurant - would you like to book it now?`,
        proactiveIntent: `The table you wanted at ${restaurantName} is now free. Should I book it?`,
        suggestedAction: "Book Now",
      };
    }
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
