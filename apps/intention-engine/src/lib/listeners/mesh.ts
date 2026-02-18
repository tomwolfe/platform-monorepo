import { RealtimeService } from "@repo/shared";
import { handleTableStackRejection } from "./tablestack";
import { verifyServiceToken } from "@repo/auth";
import { inferIntent } from "@/lib/intent";
import { generatePlan } from "@/lib/planner";
import { createAuditLog } from "@/lib/audit";
import { getAblyClient } from "@repo/shared";
import { getToolDefinitions } from "@/lib/tools";

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
  data: any;
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
  private static PROACTIVE_TRIGGERS: Record<string, (data: any) => string> = {
    ReservationRejected: (data: any) => {
      const { restaurantName, dateTime, partySize, alternativeSuggestions } = data;
      let prompt = `The reservation at ${restaurantName} for ${partySize} people at ${dateTime} was rejected.`;
      
      if (alternativeSuggestions && alternativeSuggestions.length > 0) {
        prompt += ` Available alternatives: ${alternativeSuggestions.join(', ')}.`;
      }
      
      prompt += ` Find similar restaurants and book a reservation.`;
      return prompt;
    },
    
    TableVacated: (data: any) => {
      const { restaurantName, tableId, capacity } = data;
      return `Table ${tableId} (capacity: ${capacity}) just became available at ${restaurantName}. Check if the user wants to book it.`;
    },
    
    DeliveryDelayed: (data: any) => {
      const { orderId, estimatedDelay, restaurantName, deliveryAddress } = data;
      return `Delivery order ${orderId} from ${restaurantName} to ${deliveryAddress} is delayed by ${estimatedDelay} minutes. Suggest alternatives or compensation.`;
    },
    
    ReservationCancelled: (data: any) => {
      const { restaurantName, dateTime, partySize, reason } = data;
      let prompt = `Reservation at ${restaurantName} for ${partySize} people at ${dateTime} was cancelled.`;
      if (reason) prompt += ` Reason: ${reason}.`;
      prompt += ` Help rebook or find alternatives.`;
      return prompt;
    },
    
    HighValueGuestReservation: (data: any) => {
      const { guest, reservation } = data;
      let prompt = `VIP guest ${guest.name} (${guest.visitCount} visits) booked at ${reservation.restaurantName}.`;
      
      if (guest.defaultDeliveryAddress) {
        prompt += ` Suggest arranging delivery from ${reservation.restaurantName} to ${guest.defaultDeliveryAddress} post-reservation.`;
      }
      
      return prompt;
    },
    
    ServiceDegraded: (data: any) => {
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
    data: any,
    intent: any,
    plan: any
  ): string {
    const eventSummary = this.summarizeEvent(eventName, data);
    return `Detected ${eventSummary}. Suggested action: ${plan.summary || intent.type}`;
  }

  /**
   * Summarize event for audit/UX purposes
   */
  private static summarizeEvent(eventName: string, data: any): string {
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
        return `VIP guest ${data.guest?.name || 'unknown'} reservation`;
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
   * Validates the service token before acting.
   * 
   * Enhanced to:
   * 1. Handle proactive intent generation for system events
   * 2. Push suggested plans to user's Ably channel
   */
  static async handleEvent(eventName: string, payload: any) {
    console.log(`[MeshListener] Received event: ${eventName}`);

    // Standardized Security Check
    if (!payload.token) {
      console.warn(`[MeshListener] Event ${eventName} rejected: Missing service token`);
      return;
    }

    const verified = await verifyServiceToken(payload.token);
    if (!verified) {
      console.warn(`[MeshListener] Event ${eventName} rejected: Invalid service token`);
      return;
    }

    const data = (verified as any).data;
    const traceId = (verified as any).extras?.traceId;

    // Extract user context if available
    const userId = data.userId || data.guestId || data.customerId;
    const userChannel = data.userChannel || `user:${userId}`;

    // Handle proactive events
    const proactiveEvents = [
      'ReservationRejected',
      'TableVacated',
      'DeliveryDelayed',
      'ReservationCancelled',
      'HighValueGuestReservation',
      'ServiceDegraded',
    ];

    if (proactiveEvents.includes(eventName)) {
      return await this.handleProactiveEvent({
        eventName,
        data,
        userId,
        userChannel,
        traceId,
      });
    }

    // Handle legacy events
    switch (eventName) {
      case 'reservation_rejected':
        return await handleTableStackRejection(data);

      case 'high_value_guest_reservation':
        return await this.handleHighValueGuest(data);

      case 'delivery_logged':
        console.log(`[MeshListener] Delivery logged on mesh:`, data.orderId);
        break;

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
  private static async handleHighValueGuest(data: any) {
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
