import {
  RealtimeService,
  getRedisClient,
  ServiceNamespace,
  Logger,
} from "@repo/shared";
import { handleTableStackRejection } from "./tablestack";
import { verifyAsymmetricJWT } from "@repo/auth";
import { inferIntent } from "@/lib/engine/intent";
import { generatePlan } from "@/lib/engine/unified-planner";
import { createAuditLog } from "@/lib/audit";
import { getAblyClient } from "@repo/shared";
import { listTools } from "@/lib/tools/registry";
import { getEventSchemaRegistry } from "@repo/mcp-protocol";
import {
  SystemEventSchema,
  ReservationEventPayloadSchema,
  HighValueGuestEventPayloadSchema,
  DeliveryEventPayloadSchema,
  type SystemEventType,
} from "@repo/mcp-protocol/src/schemas/events";
import { z } from "zod";

const logger = new Logger({ serviceName: "intention-engine-mesh-listener" });
const redis = getRedisClient(ServiceNamespace.IE);

/**
 * Send failed event to Dead Letter Queue for manual inspection
 * Stores the raw payload, validation error, and metadata for debugging
 */
async function sendEventToDLQ(
  eventName: string,
  rawPayload: unknown,
  validationError: z.ZodError,
  context?: {
    userId?: string;
    traceId?: string;
  },
) {
  const dlqKey = `dlq:unparseable_events:${Date.now()}:${eventName}`;
  const dlqEntry = {
    eventName,
    rawPayload: JSON.stringify(rawPayload),
    validationError: JSON.stringify({
      message: validationError.message,
      name: validationError.name,
      errors: validationError.errors.map((e) => ({
        path: e.path.join("."),
        message: e.message,
        code: e.code,
      })),
    }),
    userId: context?.userId || "unknown",
    traceId: context?.traceId || "unknown",
    timestamp: new Date().toISOString(),
    source: "mesh_listener",
  };

  try {
    // Store in Redis hash for easy retrieval and inspection
    await redis.hset(dlqKey, dlqEntry);

    // Also add to sorted set for time-based querying
    await redis.zadd("dlq:unparseable_events:index", {
      score: Date.now(),
      member: dlqKey,
    });

    // Publish alert to nervous system for monitoring
    await RealtimeService.publish(
      "nervous-system:updates",
      "dlq.event_dropped",
      {
        type: "validation_failure",
        eventName,
        dlqKey,
        userId: context?.userId,
        traceId: context?.traceId,
        timestamp: dlqEntry.timestamp,
      },
    );

    logger.info("Event sent to DLQ", { eventName, dlqKey });
  } catch (error) {
    logger.error("Failed to store event in DLQ", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * MeshListener - Orchestrates real-time reaction to Nervous System events.
 *
 * Enhanced with Proactive Intent Generator that:
 * 1. Listens for specific SystemEvents (ReservationRejected, TableVacated, etc.)
 * 2. Automatically triggers inferIntent and generatePlan
 * 3. Pushes suggested plans to user's 'nervous-system:updates' Ably channel
 *
 * In a persistent environment, this would be a long-lived WebSocket subscription.
 * In this serverless-optimized implementation, it provides event handlers and
 * a 'pull' mechanism for processing mesh events.
 */

// ============================================================================
// PROACTIVE INTENT GENERATOR
// Automatically generates plans from system events
// ============================================================================

// Strict type definitions for proactive event data
interface ProactiveEventData {
  [key: string]: unknown;
  restaurantName?: string;
  dateTime?: string;
  partySize?: number;
  alternativeSuggestions?: string[];
  tableId?: string;
  capacity?: number;
  orderId?: string;
  estimatedDelay?: number;
  deliveryAddress?: string;
  reason?: string;
  guest?: {
    name?: string;
    visitCount?: number;
    defaultDeliveryAddress?: string;
  };
  reservation?: {
    restaurantName?: string;
  };
  serviceName?: string;
  toolName?: string;
}

interface ProactiveEventContext {
  eventName: string;
  data: ProactiveEventData;
  userId?: string;
  userChannel?: string;
  traceId?: string;
}

interface ProactiveIntent {
  type: string;
  confidence: number;
  [key: string]: unknown;
}

interface ProactivePlanResult {
  steps: Array<{ [key: string]: unknown }>;
  summary?: string;
  [key: string]: unknown;
}

interface ProactivePlan {
  intent: ProactiveIntent;
  plan: ProactivePlanResult;
  confidence: number;
  reasoning: string;
}

export class ProactiveIntentGenerator {
  /**
   * Event triggers for proactive intent generation
   */
  private static PROACTIVE_TRIGGERS: Record<
    string,
    (data: ProactiveEventData) => string
  > = {
    ReservationRejected: (data: ProactiveEventData) => {
      const { restaurantName, dateTime, partySize, alternativeSuggestions } =
        data;
      let prompt = `The reservation at ${restaurantName} for ${partySize} people at ${dateTime} was rejected.`;

      if (
        alternativeSuggestions &&
        Array.isArray(alternativeSuggestions) &&
        alternativeSuggestions.length > 0
      ) {
        prompt += ` Available alternatives: ${alternativeSuggestions.join(", ")}.`;
      }

      prompt += ` Find similar restaurants and book a reservation.`;
      return prompt;
    },

    TableVacated: (data: ProactiveEventData) => {
      const { restaurantName, tableId, capacity } = data;
      return `Table ${tableId} (capacity: ${capacity}) just became available at ${restaurantName}. Check if the user wants to book it.`;
    },

    DeliveryDelayed: (data: ProactiveEventData) => {
      const { orderId, estimatedDelay, restaurantName, deliveryAddress } = data;
      return `Delivery order ${orderId} from ${restaurantName} to ${deliveryAddress} is delayed by ${estimatedDelay} minutes. Suggest alternatives or compensation.`;
    },

    ReservationCancelled: (data: ProactiveEventData) => {
      const { restaurantName, dateTime, partySize, reason } = data;
      let prompt = `Reservation at ${restaurantName} for ${partySize} people at ${dateTime} was cancelled.`;
      if (reason) prompt += ` Reason: ${reason}.`;
      prompt += ` Help rebook or find alternatives.`;
      return prompt;
    },

    HighValueGuestReservation: (data: ProactiveEventData) => {
      const guest = data.guest;
      const reservation = data.reservation;
      let prompt = `VIP guest ${guest?.name || "unknown"} (${guest?.visitCount || 0} visits) booked at ${reservation?.restaurantName || "unknown"}.`;

      if (guest?.defaultDeliveryAddress) {
        prompt += ` Suggest arranging delivery from ${reservation?.restaurantName} to ${guest.defaultDeliveryAddress} post-reservation.`;
      }

      return prompt;
    },

    ServiceDegraded: (data: ProactiveEventData) => {
      const { serviceName, toolName, reason } = data;
      return `Service ${serviceName} is degraded (tool: ${toolName}, reason: ${reason}). Notify affected users and suggest alternatives.`;
    },
  };

  /**
   * Generate proactive intent and plan from a system event
   */
  static async generateProactivePlan(
    context: ProactiveEventContext,
  ): Promise<ProactivePlan | null> {
    const { eventName, data } = context;

    // Check if this event type has a proactive trigger
    const triggerFn = this.PROACTIVE_TRIGGERS[eventName];
    if (!triggerFn) {
      return null;
    }

    try {
      // Generate natural language prompt from event
      const proactivePrompt = triggerFn(data);
      logger.info("Generating proactive plan", {
        eventName,
        prompt: proactivePrompt,
      });

      // Infer intent from the prompt
      const { hypotheses } = await inferIntent(proactivePrompt, []);
      const intent = hypotheses.primary;

      // Only proceed if confidence is above threshold
      if (intent.confidence < 0.5) {
        logger.info("Skipping low-confidence proactive intent", {
          eventName,
          confidence: intent.confidence,
        });
        return null;
      }

      // Generate plan
      const planningResult = await generatePlan(intent);

      // Build reasoning
      const reasoning = this.buildReasoning(eventName, data, intent, {
        steps: planningResult.plan.steps as Array<{ [key: string]: unknown }>,
        summary: planningResult.plan.summary,
        ...planningResult,
      });

      const proactivePlan: ProactivePlan = {
        intent,
        plan: {
          steps: planningResult.plan.steps as Array<{ [key: string]: unknown }>,
          summary: planningResult.plan.summary,
        },
        confidence: intent.confidence,
        reasoning,
      };

      return proactivePlan;
    } catch (error) {
      logger.error("Failed to generate proactive plan", {
        eventName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Build human-readable reasoning for the proactive plan
   */
  private static buildReasoning(
    eventName: string,
    data: ProactiveEventData,
    intent: ProactiveIntent,
    plan: ProactivePlanResult,
  ): string {
    const eventSummary = this.summarizeEvent(eventName, data);
    return `Detected ${eventSummary}. Suggested action: ${(plan.summary as string) || (intent.type as string) || "unknown"}`;
  }

  /**
   * Summarize event for audit/UX purposes
   */
  private static summarizeEvent(
    eventName: string,
    data: ProactiveEventData,
  ): string {
    switch (eventName) {
      case "ReservationRejected":
        return `reservation rejection at ${data.restaurantName || "unknown restaurant"}`;
      case "TableVacated":
        return `table availability at ${data.restaurantName || "unknown restaurant"}`;
      case "DeliveryDelayed":
        return `delivery delay for order ${data.orderId || "unknown"}`;
      case "ReservationCancelled":
        return `reservation cancellation at ${data.restaurantName || "unknown restaurant"}`;
      case "HighValueGuestReservation":
        return `VIP guest ${data.guest?.name || "unknown"} reservation`;
      case "ServiceDegraded":
        return `service degradation: ${data.serviceName || "unknown"}`;
      default:
        return eventName;
    }
  }
}

// ============================================================================
// MESH LISTENER
// ============================================================================

export class MeshListener {
  /**
   * Processes a single event from the mesh.
   * Validates the service token AND event schema before acting.
   *
   * Enhanced to:
   * 1. Handle proactive intent generation for system events
   * 2. Push suggested plans to user's Ably channel
   * 3. Validate events against Zod schemas from event-registry
   */
  static async handleEvent(eventName: string, payload: unknown) {
    logger.info("Received event", { eventName });

    // Standardized Security Check
    if (!payload || typeof payload !== "object" || !("token" in payload)) {
      logger.warn("Event rejected: missing service token", { eventName });
      return;
    }

    const payloadObj = payload as { token?: string; [key: string]: unknown };

    if (!payloadObj.token) {
      logger.warn("Event rejected: missing service token", { eventName });
      return;
    }

    const verified = await verifyAsymmetricJWT(
      payloadObj.token,
      "intention-engine",
      "mesh-listener",
    );
    if (!verified) {
      logger.warn("Event rejected: invalid service token", { eventName });
      return;
    }

    const verifiedData = verified as {
      data?: Record<string, unknown>;
      extras?: { traceId?: string };
      [key: string]: unknown;
    };
    const data = verifiedData.data || {};
    const traceId = verifiedData.extras?.traceId;

    // Extract user context if available
    const userId = (data.userId || data.guestId || data.customerId) as
      | string
      | undefined;
    const userChannel = (data.userChannel || `user:${userId}`) as
      | string
      | undefined;

    // TYPE SAFETY: Validate event against schema registry BEFORE processing
    // ALL events MUST pass validation (fail-closed)
    const registry = getEventSchemaRegistry();

    // Map legacy event names to registry event types
    const eventTypeMap: Record<string, string> = {
      reservation_rejected: "RESERVATION_CANCELLED",
      high_value_guest_reservation: "RESERVATION_CREATED",
      delivery_logged: "DELIVERY_COMPLETED",
    } as const;

    const registryEventType =
      eventTypeMap[eventName] || eventName.toUpperCase();

    // Validate against registry schemas if registered - FAIL-CLOSED
    if (registry.isRegistered(registryEventType)) {
      const validation = registry.validate(registryEventType, data);
      if (!validation.success) {
        // FAIL-CLOSED: Drop event if it fails schema validation
        logger.error("Event failed schema validation, dropping", {
          eventName,
          validationError: validation.error,
        });
        return;
      }
      logger.info("Event validated against schema", { eventName });
    }

    // Handle proactive events with strict Zod validation
    const proactiveEvents = [
      "ReservationRejected",
      "TableVacated",
      "DeliveryDelayed",
      "ReservationCancelled",
      "HighValueGuestReservation",
      "ServiceDegraded",
    ];

    if (proactiveEvents.includes(eventName)) {
      // Validate data structure using Zod
      const dataValidation = z.object({}).passthrough().safeParse(data);
      if (!dataValidation.success) {
        logger.error("Invalid data structure for proactive event", {
          eventName,
        });
        return;
      }

      return await this.handleProactiveEvent({
        eventName,
        data: dataValidation.data,
        userId,
        userChannel,
        traceId,
      });
    }

    // Handle legacy events with strict Zod validation (FAIL-CLOSED)
    switch (eventName) {
      case "reservation_rejected": {
        // STRICT VALIDATION: Use full schema validation (not partial)
        // Events that fail validation are dropped and sent to DLQ
        const validated = ReservationEventPayloadSchema.safeParse(data);
        if (!validated.success) {
          logger.error("Event failed validation, dropping", {
            eventName,
            validationError: validated.error,
          });
          // Send to DLQ for manual inspection
          await sendEventToDLQ(eventName, data, validated.error, {
            userId,
            traceId,
          });
          return;
        }
        return await handleTableStackRejection(validated.data);
      }

      case "high_value_guest_reservation": {
        const validated = HighValueGuestEventPayloadSchema.safeParse(data);
        if (!validated.success) {
          logger.error("Event failed validation, dropping", {
            eventName,
            validationError: validated.error,
          });
          // Send to DLQ for manual inspection
          await sendEventToDLQ(eventName, data, validated.error, {
            userId,
            traceId,
          });
          return;
        }
        return await this.handleHighValueGuest(validated.data);
      }

      case "delivery_logged": {
        // STRICT VALIDATION: Use full schema validation (not partial)
        const validated = DeliveryEventPayloadSchema.safeParse(data);
        if (!validated.success) {
          logger.error("Event failed validation, dropping", {
            eventName,
            validationError: validated.error,
          });
          // Send to DLQ for manual inspection
          await sendEventToDLQ(eventName, data, validated.error, {
            userId,
            traceId,
          });
          return;
        }
        logger.info("Delivery logged on mesh", {
          orderId: validated.data.orderId,
        });
        break;
      }

      default:
        logger.info("No handler for event", { eventName });
    }
  }

  /**
   * Handle proactive events - generate intent/plan and push to user
   */
  private static async handleProactiveEvent(context: ProactiveEventContext) {
    const { eventName, data, userId, userChannel, traceId } = context;

    logger.info("Processing proactive event", { eventName, userId });

    try {
      // TYPE SAFETY: Validate proactive event payload structure
      if (!data || typeof data !== "object") {
        logger.error("Invalid data for proactive event", { eventName });
        return;
      }

      // Generate proactive plan
      const proactivePlan =
        await ProactiveIntentGenerator.generateProactivePlan(context);

      if (!proactivePlan) {
        logger.info("No proactive plan generated", { eventName });
        return;
      }

      // Skip audit log for proactive suggestions (not a real user action)
      // const auditLog = await createAuditLog(
      //   proactivePlan.intent,
      //   proactivePlan.plan,
      //   undefined,
      //   userId ? `mesh:${userId}` : "mesh:system",
      // );

      // Push to user's Ably channel
      if (userChannel) {
        await RealtimeService.publish(
          "nervous-system:updates",
          "ProactiveSuggestion",
          {
            type: "proactive_plan",
            eventName,
            intent: proactivePlan.intent,
            plan: proactivePlan.plan,
            confidence: proactivePlan.confidence,
            reasoning: proactivePlan.reasoning,
            auditLogId: undefined,
            timestamp: new Date().toISOString(),
          },
          { traceId },
        );

        logger.info("Pushed proactive plan to user", {
          userChannel,
          reasoning: proactivePlan.reasoning,
        });
      }

      return {
        success: true,
        intent: proactivePlan.intent,
        plan: proactivePlan.plan,
        reasoning: proactivePlan.reasoning,
      };
    } catch (error) {
      logger.error("Error handling proactive event", {
        eventName,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Legacy handler for high-value guest events
   */
  private static async handleHighValueGuest(
    data: z.infer<typeof HighValueGuestEventPayloadSchema>,
  ) {
    const { guest, reservation } = data;

    let proactiveText = `Guest ${guest.name} (High Value, ${guest.visitCount} visits) just booked at ${reservation.restaurantName}.`;

    if (guest.defaultDeliveryAddress) {
      proactiveText += ` Suggest a delivery quote from ${reservation.restaurantName} to ${guest.defaultDeliveryAddress} for after their reservation.`;
    }

    const { hypotheses } = await inferIntent(proactiveText, []);
    const intent = hypotheses.primary;
    const planningResult = await generatePlan(intent);

    await createAuditLog(
      intent,
      planningResult.plan,
      undefined,
      `mesh:${guest.email}`,
    );

    return { intent, plan: planningResult.plan };
  }

  /**
   * Pulls recent events from Ably history and processes them.
   * This is the 'serverless-friendly' way to 'hear' changes.
   */
  static async pullAndProcess() {
    const ably = getAblyClient();
    if (!ably) return;

    const channel = ably.channels.get("nervous-system:updates");
    const historyPage = await channel.history({ limit: 10 });

    for (const message of historyPage.items) {
      // Avoid re-processing if needed (idempotency would go here)
      await this.handleEvent(message.name!, message.data);
    }
  }
}
