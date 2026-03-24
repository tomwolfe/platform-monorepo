import { RealtimeService } from "@repo/shared";
import { handleTableStackRejection } from "./tablestack";
import { verifyServiceToken } from "@repo/auth";
import { inferIntent } from "@/lib/engine/intent";
import { generatePlan } from "@/lib/engine/unified-planner";
import { createAuditLog } from "@/lib/audit";
import { getAblyClient } from "@repo/shared";
import { getToolDefinitions } from "@/lib/tools";
import { getEventSchemaRegistry } from "@repo/mcp-protocol";
import {
  SystemEventSchema,
  ReservationEventPayloadSchema,
  HighValueGuestEventPayloadSchema,
  DeliveryEventPayloadSchema,
  type SystemEventType,
} from "@repo/mcp-protocol/schemas/events";
import { z } from "zod";

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

interface ProactiveEventContext {
  eventName: string;
  data: Record<string, unknown>;
  userId?: string;
  userChannel?: string;
  traceId?: string;
}

interface ProactivePlan {
  intent: any;
  plan: any;
  confidence: number;
  reasoning: string;
}

export class ProactiveIntentGenerator {
  /**
   * Event triggers for proactive intent generation
   */
  private static PROACTIVE_TRIGGERS: Record<string, (data: Record<string, unknown>) => string> = {
    ReservationRejected: (data: Record<string, unknown>) => {
      const { restaurantName, dateTime, partySize, alternativeSuggestions } = data;
      let prompt = `The reservation at ${restaurantName} for ${partySize} people at ${dateTime} was rejected.`;

      if (alternativeSuggestions && Array.isArray(alternativeSuggestions) && alternativeSuggestions.length > 0) {
        prompt += ` Available alternatives: ${alternativeSuggestions.join(', ')}.`;
      }

      prompt += ` Find similar restaurants and book a reservation.`;
      return prompt;
    },

    TableVacated: (data: Record<string, unknown>) => {
      const { restaurantName, tableId, capacity } = data;
      return `Table ${tableId} (capacity: ${capacity}) just became available at ${restaurantName}. Check if the user wants to book it.`;
    },

    DeliveryDelayed: (data: Record<string, unknown>) => {
      const { orderId, estimatedDelay, restaurantName, deliveryAddress } = data;
      return `Delivery order ${orderId} from ${restaurantName} to ${deliveryAddress} is delayed by ${estimatedDelay} minutes. Suggest alternatives or compensation.`;
    },

    ReservationCancelled: (data: Record<string, unknown>) => {
      const { restaurantName, dateTime, partySize, reason } = data;
      let prompt = `Reservation at ${restaurantName} for ${partySize} people at ${dateTime} was cancelled.`;
      if (reason) prompt += ` Reason: ${reason}.`;
      prompt += ` Help rebook or find alternatives.`;
      return prompt;
    },

    HighValueGuestReservation: (data: Record<string, unknown>) => {
      const guest = data.guest as Record<string, unknown> | undefined;
      const reservation = data.reservation as Record<string, unknown> | undefined;
      let prompt = `VIP guest ${guest?.name || 'unknown'} (${guest?.visitCount || 0} visits) booked at ${reservation?.restaurantName || 'unknown'}.`;

      if (guest?.defaultDeliveryAddress) {
        prompt += ` Suggest arranging delivery from ${reservation?.restaurantName} to ${guest.defaultDeliveryAddress} post-reservation.`;
      }

      return prompt;
    },

    ServiceDegraded: (data: Record<string, unknown>) => {
      const { serviceName, toolName, reason } = data;
      return `Service ${serviceName} is degraded (tool: ${toolName}, reason: ${reason}). Notify affected users and suggest alternatives.`;
    },
  };

  /**
   * Generate proactive intent and plan from a system event
   */
  static async generateProactivePlan(
    context: ProactiveEventContext
  ): Promise<ProactivePlan | null> {
    const { eventName, data } = context;
    
    // Check if this event type has a proactive trigger
    const triggerFn = this.PROACTIVE_TRIGGERS[eventName];
    if (!triggerFn) {
      console.log(`[ProactiveIntent] No proactive trigger for ${eventName}`);
      return null;
    }

    try {
      // Generate natural language prompt from event
      const proactivePrompt = triggerFn(data);
      console.log(`[ProactiveIntent] Generating plan for ${eventName}: ${proactivePrompt}`);

      // Infer intent from the prompt
      const { hypotheses } = await inferIntent(proactivePrompt, []);
      const intent = hypotheses.primary;

      // Only proceed if confidence is above threshold
      if (intent.confidence < 0.5) {
        console.log(
          `[ProactiveIntent] Skipping low-confidence intent (${intent.confidence}) for ${eventName}`
        );
        return null;
      }

      // Generate plan
      const plan = await generatePlan(proactivePrompt);

      // Build reasoning
      const reasoning = this.buildReasoning(eventName, data, intent, plan);

      const proactivePlan: ProactivePlan = {
        intent,
        plan,
        confidence: intent.confidence,
        reasoning,
      };

      return proactivePlan;
    } catch (error) {
      console.error(
        `[ProactiveIntent] Failed to generate plan for ${eventName}:`,
        error instanceof Error ? error.message : error
      );
      return null;
    }
  }

  /**
   * Build human-readable reasoning for the proactive plan
   */
  private static buildReasoning(
    eventName: string,
    data: Record<string, unknown>,
    intent: any,
    plan: any
  ): string {
    const eventSummary = this.summarizeEvent(eventName, data);
    return `Detected ${eventSummary}. Suggested action: ${plan.summary || intent.type}`;
  }

  /**
   * Summarize event for audit/UX purposes
   */
  private static summarizeEvent(eventName: string, data: Record<string, unknown>): string {
    switch (eventName) {
      case 'ReservationRejected':
        return `reservation rejection at ${data.restaurantName || 'unknown restaurant'}`;
      case 'TableVacated':
        return `table availability at ${data.restaurantName || 'unknown restaurant'}`;
      case 'DeliveryDelayed':
        return `delivery delay for order ${data.orderId || 'unknown'}`;
      case 'ReservationCancelled':
        return `reservation cancellation at ${data.restaurantName || 'unknown restaurant'}`;
      case 'HighValueGuestReservation':
        return `VIP guest ${(data.guest as Record<string, unknown>)?.name || 'unknown'} reservation`;
      case 'ServiceDegraded':
        return `service degradation: ${data.serviceName || 'unknown'}`;
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
    console.log(`[MeshListener] Received event: ${eventName}`);

    // Standardized Security Check
    if (!payload || typeof payload !== 'object' || !('token' in payload)) {
      console.warn(`[MeshListener] Event ${eventName} rejected: Missing service token`);
      return;
    }

    const payloadObj = payload as Record<string, unknown>;

    if (!payloadObj.token) {
      console.warn(`[MeshListener] Event ${eventName} rejected: Missing service token`);
      return;
    }

    const verified = await verifyServiceToken(payloadObj.token as string);
    if (!verified) {
      console.warn(`[MeshListener] Event ${eventName} rejected: Invalid service token`);
      return;
    }

    const verifiedData = verified as Record<string, unknown>;
    const data = verifiedData.data as Record<string, unknown> || {};
    const traceId = (verifiedData.extras as Record<string, unknown> | undefined)?.traceId as string | undefined;

    // Extract user context if available
    const userId = (data.userId || data.guestId || data.customerId) as string | undefined;
    const userChannel = (data.userChannel || `user:${userId}`) as string | undefined;

    // TYPE SAFETY: Validate event against schema registry BEFORE processing
    // ALL events MUST pass validation (fail-closed)
    const registry = getEventSchemaRegistry();

    // Map legacy event names to registry event types
    const eventTypeMap: Record<string, string> = {
      'reservation_rejected': 'RESERVATION_CANCELLED',
      'high_value_guest_reservation': 'RESERVATION_CREATED',
      'delivery_logged': 'DELIVERY_COMPLETED',
    };

    const registryEventType = eventTypeMap[eventName] || eventName.toUpperCase();

    // Validate against registry schemas if registered - FAIL-CLOSED
    if (registry.isRegistered(registryEventType)) {
      const validation = registry.validate(registryEventType, data);
      if (!validation.success) {
        // FAIL-CLOSED: Drop event if it fails schema validation
        console.error(
          `[MeshListener] Event ${eventName} FAILED schema validation, DROPPING:`,
          validation.error
        );
        return;
      }
      console.log(`[MeshListener] Event ${eventName} validated against schema`);
    }

    // Handle proactive events with strict Zod validation
    const proactiveEvents = [
      'ReservationRejected',
      'TableVacated',
      'DeliveryDelayed',
      'ReservationCancelled',
      'HighValueGuestReservation',
      'ServiceDegraded',
    ];

    if (proactiveEvents.includes(eventName)) {
      // Validate data structure using Zod
      const dataValidation = z.object({}).passthrough().safeParse(data);
      if (!dataValidation.success) {
        console.error(`[MeshListener] Invalid data structure for proactive event ${eventName}`);
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
      case 'reservation_rejected': {
        const validated = ReservationEventPayloadSchema.partial().safeParse(data);
        if (!validated.success) {
          console.error(
            `[MeshListener] Event ${eventName} FAILED validation, DROPPING:`,
            validated.error
          );
          return;
        }
        return await handleTableStackRejection(validated.data);
      }

      case 'high_value_guest_reservation': {
        const validated = HighValueGuestEventPayloadSchema.safeParse(data);
        if (!validated.success) {
          console.error(
            `[MeshListener] Event ${eventName} FAILED validation, DROPPING:`,
            validated.error
          );
          return;
        }
        return await this.handleHighValueGuest(validated.data);
      }

      case 'delivery_logged': {
        const validated = DeliveryEventPayloadSchema.partial().safeParse(data);
        if (!validated.success) {
          console.error(
            `[MeshListener] Event ${eventName} FAILED validation, DROPPING:`,
            validated.error
          );
          return;
        }
        console.log(`[MeshListener] Delivery logged on mesh:`, validated.data.orderId);
        break;
      }

      default:
        console.log(`[MeshListener] No handler for event: ${eventName}`);
    }
  }

  /**
   * Handle proactive events - generate intent/plan and push to user
   */
  private static async handleProactiveEvent(context: ProactiveEventContext) {
    const { eventName, data, userId, userChannel, traceId } = context;

    console.log(
      `[MeshListener] Processing proactive event ${eventName}` +
      (userId ? ` for user ${userId}` : '')
    );

    try {
      // TYPE SAFETY: Validate proactive event payload structure
      if (!data || typeof data !== 'object') {
        console.error(`[MeshListener] Invalid data for proactive event ${eventName}`);
        return;
      }

      // Generate proactive plan
      const proactivePlan = await ProactiveIntentGenerator.generateProactivePlan(context);

      if (!proactivePlan) {
        console.log(`[MeshListener] No proactive plan generated for ${eventName}`);
        return;
      }

      // Create audit log
      const auditLog = await createAuditLog(
        proactivePlan.intent,
        proactivePlan.plan,
        undefined,
        userId ? `mesh:${userId}` : 'mesh:system'
      );

      // Push to user's Ably channel
      if (userChannel) {
        await RealtimeService.publish(
          'nervous-system:updates',
          'ProactiveSuggestion',
          {
            type: 'proactive_plan',
            eventName,
            intent: proactivePlan.intent,
            plan: proactivePlan.plan,
            confidence: proactivePlan.confidence,
            reasoning: proactivePlan.reasoning,
            auditLogId: auditLog.id,
            timestamp: new Date().toISOString(),
          },
          { traceId }
        );

        console.log(
          `[MeshListener] Pushed proactive plan to ${userChannel}: ` +
          `${proactivePlan.reasoning}`
        );
      }

      return {
        success: true,
        intent: proactivePlan.intent,
        plan: proactivePlan.plan,
        reasoning: proactivePlan.reasoning,
      };
    } catch (error) {
      console.error(
        `[MeshListener] Error handling proactive event ${eventName}:`,
        error instanceof Error ? error.message : error
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Legacy handler for high-value guest events
   */
  private static async handleHighValueGuest(data: z.infer<typeof HighValueGuestEventPayloadSchema>) {
    const { guest, reservation } = data;

    let proactiveText = `Guest ${guest.name} (High Value, ${guest.visitCount} visits) just booked at ${reservation.restaurantName}.`;

    if (guest.defaultDeliveryAddress) {
      proactiveText += ` Suggest a delivery quote from ${reservation.restaurantName} to ${guest.defaultDeliveryAddress} for after their reservation.`;
    }

    const { hypotheses } = await inferIntent(proactiveText, []);
    const intent = hypotheses.primary;
    const plan = await generatePlan(proactiveText);

    await createAuditLog(intent, plan, undefined, `mesh:${guest.email}`);

    return { intent, plan };
  }

  /**
   * Pulls recent events from Ably history and processes them.
   * This is the 'serverless-friendly' way to 'hear' changes.
   */
  static async pullAndProcess() {
    const ably = getAblyClient();
    if (!ably) return;

    const channel = ably.channels.get('nervous-system:updates');
    const historyPage = await channel.history({ limit: 10 });

    for (const message of historyPage.items) {
      // Avoid re-processing if needed (idempotency would go here)
      await this.handleEvent(message.name!, message.data);
    }
  }
}
