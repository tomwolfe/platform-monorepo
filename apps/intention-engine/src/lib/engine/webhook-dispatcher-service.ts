/**
 * Webhook Dispatcher Service
 *
 * Handles routing and processing of incoming webhooks from external systems.
 * Extracted from the webhooks API route to improve testability and separation of concerns.
 *
 * Responsibilities:
 * - Route events to appropriate handlers
 * - Handle failover orchestration
 * - Process high-value guest events
 * - Manage table vacated re-engagement
 * - Publish real-time updates via Ably
 *
 * @see Phase 3.2: Route De-bloating & Abstraction
 */

import { z } from "zod";
import { inferIntent } from "./intent";
import { generatePlan } from "./unified-planner";
import { createAuditLog } from "@/lib/audit";
import { handleTableStackRejection } from "@/lib/listeners/tablestack";
import { signServiceToken } from "@repo/auth";
import {
  IdempotencyService,
  IDEMPOTENCY_KEY_HEADER,
  RealtimeService,
  Logger,
} from "@repo/shared";
import { getAblyClient } from "@repo/shared";
import {
  NervousSystemObserver,
  type TableVacatedEvent,
} from "@/lib/listeners/nervous-system-observer";
import {
  ReservationEventPayloadSchema,
  HighValueGuestEventPayloadSchema,
  SystemEventSchema,
} from "@repo/mcp-protocol/src/schemas/events";
import type { Redis } from "@upstash/redis";

const logger = new Logger({ serviceName: "intention-engine" });

// ============================================================================
// TYPES
// ============================================================================

export interface WebhookEvent {
  event: string;
  guest?: {
    name: string;
    email: string;
    visitCount: number;
    defaultDeliveryAddress?: string | null;
  };
  reservation?: {
    id?: string;
    restaurantName: string;
    startTime: string;
    partySize: number;
  };
  guestEmail?: string;
  startTime?: string;
  partySize?: number;
  visitCount?: number;
  preferences?: Record<string, unknown>;
  tableId?: string;
  restaurantId?: string;
  restaurantName?: string;
  restaurantSlug?: string;
  capacity?: number;
  timestamp?: string;
  traceId?: string;
}

export interface WebhookHandlerResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  statusCode?: number;
}

export interface WebhookContext {
  rawBody: string;
  signature?: string | null;
  timestamp?: number | null;
  idempotencyKey?: string | null;
}

// ============================================================================
// WEBHOOK DISPATCHER SERVICE
// ============================================================================

export class WebhookDispatcherService {
  private redis: Redis;
  private observer: NervousSystemObserver;
  private idempotencyService: IdempotencyService | undefined;

  constructor(redis: Redis) {
    this.redis = redis;
    this.observer = new NervousSystemObserver();
  }

  /**
   * Lazily initialize IdempotencyService to avoid unnecessary instantiation
   */
  private getIdempotencyService(): IdempotencyService {
    if (!this.idempotencyService) {
      this.idempotencyService = new IdempotencyService(this.redis);
    }
    return this.idempotencyService;
  }

  /**
   * Process an incoming webhook event
   * This is the main entry point
   */
  async processWebhook(context: WebhookContext): Promise<WebhookHandlerResult> {
    const { rawBody, signature, timestamp, idempotencyKey } = context;

    try {
      // Parse and validate body
      const body = JSON.parse(rawBody);
      const validatedBody = this.validateEventBody(body);

      if (!validatedBody.valid) {
        logger.warn({
          message: "[WebhookDispatcher] Schema mismatch",
          error: validatedBody.error,
        });
        return {
          success: false,
          message: "Event received but schema mismatch",
          statusCode: 200,
        };
      }

      const event = validatedBody.data.event;

      // Route to appropriate handler
      switch (event) {
        case "reservation_rejected":
          return this.handleReservationRejected(validatedBody.data);

        case "high_value_guest_reservation":
          return this.handleHighValueGuest(validatedBody.data);

        case "table_vacated":
          return this.handleTableVacated(validatedBody.data);

        default:
          logger.info({
            message: "[WebhookDispatcher] Unknown event type",
            details: { event },
          });
          return {
            success: true,
            message: "Event ignored",
          };
      }
    } catch (error) {
      logger.error({
        message: "[WebhookDispatcher] Error processing webhook",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Verify webhook signature
   */
  async verifySignature(
    rawBody: string,
    signature?: string | null,
    timestamp?: number | null,
  ): Promise<boolean> {
    const { verifySignature } = await import("@repo/auth");

    if (!signature || !timestamp) {
      return false;
    }

    return await verifySignature(rawBody, signature, timestamp);
  }

  /**
   * Check idempotency
   */
  async checkIdempotency(idempotencyKey: string | null): Promise<boolean> {
    if (!idempotencyKey) {
      return false;
    }

    return await this.getIdempotencyService().isDuplicate(
      idempotencyKey,
      "intention_engine_webhook",
    );
  }

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  /**
   * Handle reservation rejected event - triggers failover orchestration
   */
  private async handleReservationRejected(
    data: WebhookEvent,
  ): Promise<WebhookHandlerResult> {
    const failoverPayload = {
      guestEmail: data.guestEmail || "",
      restaurantName: data.restaurantName || "",
      startTime: data.startTime || "",
      partySize: data.partySize || 0,
      visitCount: data.visitCount || 0,
      preferences: data.preferences || {},
    };

    const result = await handleTableStackRejection(failoverPayload);

    // Push alternative to user's frontend via Ably
    if (result.plan) {
      await this.publishToAbly(
        "nervous-system:updates",
        "FailoverAlternative",
        {
          guestEmail: failoverPayload.guestEmail,
          originalRestaurant: failoverPayload.restaurantName,
          alternativePlan: result.plan,
          hypotheses: result.hypotheses,
          timestamp: new Date().toISOString(),
        },
      );

      logger.info({
        message: `[Failover Orchestrator] Alternative pushed to Ably for ${failoverPayload.guestEmail}`,
      });
    }

    return {
      success: true,
      message: "Failover initiated",
      data: {
        hypotheses: result.hypotheses,
        plan_id: result.plan?.intent_id,
      },
    };
  }

  /**
   * Handle high-value guest reservation - proactive engagement
   */
  private async handleHighValueGuest(
    data: WebhookEvent,
  ): Promise<WebhookHandlerResult> {
    const { guest, reservation } = data;

    if (!guest || !reservation) {
      return {
        success: false,
        message: "High-value guest event missing required fields",
        statusCode: 400,
      };
    }

    // Build proactive engagement message
    let proactiveText = `Guest ${guest.name} (High Value, ${guest.visitCount} visits) just booked at ${reservation.restaurantName}.`;

    if (guest.defaultDeliveryAddress) {
      proactiveText += ` Suggest a delivery quote from ${reservation.restaurantName} to ${guest.defaultDeliveryAddress} for after their reservation.`;
    } else {
      proactiveText += ` Prepare a welcome message or special offer for their arrival.`;
    }

    logger.info({
      message: "[WebhookDispatcher] Proactive Trigger",
      details: { proactiveText },
    });

    // Infer intent and generate plan
    const { hypotheses } = await inferIntent(proactiveText, []);
    const intent = hypotheses.primary;
    const plan = await generatePlan(proactiveText);

    await createAuditLog(intent, plan, undefined, `webhook:${guest.email}`);

    return {
      success: true,
      message: "High-value guest event processed",
      data: {
        proactive_action: guest.defaultDeliveryAddress
          ? "delivery_quote_suggested"
          : "welcome_offer_prepared",
      },
    };
  }

  /**
   * Handle table vacated event - proactive re-engagement
   */
  private async handleTableVacated(
    data: WebhookEvent,
  ): Promise<WebhookHandlerResult> {
    const {
      tableId,
      restaurantId,
      restaurantName,
      restaurantSlug,
      capacity,
      timestamp,
      traceId,
    } = data;

    if (!tableId || !restaurantId) {
      logger.warn({
        message:
          "[TableVacated] Missing required fields (tableId or restaurantId)",
      });
      return {
        success: true,
        message: "Event received but missing required fields",
      };
    }

    logger.info({
      message: `[TableVacated] Table ${tableId} at ${restaurantName || restaurantId} is now available`,
    });

    // Create TableVacated event payload
    const tableVacatedEvent: TableVacatedEvent = {
      tableId,
      restaurantId,
      restaurantName: restaurantName || undefined,
      restaurantSlug: restaurantSlug || undefined,
      capacity: capacity || undefined,
      timestamp: timestamp || new Date().toISOString(),
      traceId: traceId || undefined,
    };

    // Sign token for event
    const token = await signServiceToken({
      event: "TableVacated",
      data: tableVacatedEvent,
      timestamp: Date.now(),
    });

    // Use Nervous System Observer to handle proactive re-engagement
    const result = await this.observer.handleTableVacated({
      event: tableVacatedEvent,
      token,
    });

    if (result.success) {
      logger.info({
        message: `[TableVacated] Proactive re-engagement complete: ${result.usersNotified} users notified`,
        details: {
          usersNotified: result.usersNotified,
          llmGenerated: !!result.llmGeneratedContent,
          proactiveIntent: result.llmGeneratedContent?.proactiveIntent,
          suggestedAction: result.llmGeneratedContent?.suggestedAction,
        },
      });

      return {
        success: true,
        message: "Table vacated event processed",
        data: {
          usersNotified: result.usersNotified,
          llmGenerated: !!result.llmGeneratedContent,
          proactiveIntent: result.llmGeneratedContent?.proactiveIntent,
          suggestedAction: result.llmGeneratedContent?.suggestedAction,
        },
      };
    } else {
      logger.warn({
        message: "[TableVacated] Re-engagement failed",
        error: result.error,
      });
      return {
        success: true,
        message: "Table vacated event received but re-engagement failed",
        data: {
          error: result.error,
        },
      };
    }
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  /**
   * Validate event body against canonical schemas from @repo/mcp-protocol
   */
  private validateEventBody(body: unknown): {
    valid: boolean;
    data?: WebhookEvent;
    error?: string;
  } {
    // Try parsing as a SystemEvent first (full envelope format)
    const systemEventResult = SystemEventSchema.safeParse(body);
    if (systemEventResult.success) {
      return {
        valid: true,
        data: systemEventResult.data.payload as unknown as WebhookEvent,
      };
    }

    // Fallback: try domain-specific payload schemas
    // Reservation events
    const reservationResult = ReservationEventPayloadSchema.safeParse(body);
    if (reservationResult.success) {
      return {
        valid: true,
        data: reservationResult.data as unknown as WebhookEvent,
      };
    }

    // High-value guest events
    const guestResult = HighValueGuestEventPayloadSchema.safeParse(body);
    if (guestResult.success) {
      return {
        valid: true,
        data: guestResult.data as unknown as WebhookEvent,
      };
    }

    // If no canonical schema matches, fall back to minimal structural validation
    const MinimalWebhookEventSchema = z.object({
      event: z.string(),
    });

    const minimalResult = MinimalWebhookEventSchema.safeParse(body);
    if (!minimalResult.success) {
      return {
        valid: false,
        error: minimalResult.error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join("; "),
      };
    }

    return {
      valid: true,
      data: minimalResult.data as WebhookEvent,
    };
  }

  /**
   * Publish event to Ably
   */
  private async publishToAbly(
    channelName: string,
    eventName: string,
    data: unknown,
  ): Promise<void> {
    try {
      await RealtimeService.publish(channelName, eventName, data, {});
    } catch (err) {
      logger.error({
        message: "[WebhookDispatcher] Ably publish failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createWebhookDispatcherService(
  redis: Redis,
): WebhookDispatcherService {
  return new WebhookDispatcherService(redis);
}
