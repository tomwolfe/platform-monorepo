/**
 * Event Schema Registry - Nervous System Event Mesh
 *
 * Problem: Currently, Ably is used as a messaging bus, but events lack formal schemas.
 * This makes it hard to validate, version, and evolve events across the ecosystem.
 *
 * Solution: Event Schema Registry with versioned Zod schemas
 * - Every event (e.g., `TableVacated`) has a versioned Zod schema
 * - Schemas are centralized in @repo/mcp-protocol
 * - Events are validated against schemas before publishing
 * - Schema evolution is supported via versioning
 *
 * Architecture:
 * 1. EventSchemaRegistry maintains a map of event types to schemas
 * 2. Each event has a version (e.g., "table_vacated:v1")
 * 3. Events are validated before publishing to Ably
 * 4. Dead-letter events are tracked for schema mismatches
 *
 * Usage:
 * ```typescript
 * // Register schema
 * registry.register('table_vacated', TableVacatedEventSchema, 'v1');
 *
 * // Validate and publish
 * const validated = registry.validate('table_vacated', eventData, 'v1');
 * await RealtimeService.publishNervousSystemEvent('TABLE_VACATED', validated);
 * ```
 *
 * @package @repo/mcp-protocol
 */

import { z } from "zod";

// ============================================================================
// BASE EVENT SCHEMA
// All nervous system events extend this base
// ============================================================================

export const BaseEventSchema = z.object({
  // Event metadata
  eventId: z.string().uuid().default(() => crypto.randomUUID()),
  eventType: z.string(),
  version: z.string(),
  timestamp: z.string().datetime(),
  // Distributed tracing
  traceId: z.string().uuid().optional(),
  correlationId: z.string().uuid().optional(),
  // Causality
  causationId: z.string().uuid().optional(), // ID of the event that caused this one
  sagaId: z.string().uuid().optional(), // Saga this event belongs to
  // Publisher info
  publisher: z.object({
    service: z.string(),
    version: z.string(),
    instanceId: z.string().optional(),
  }),
});

export type BaseEvent = z.infer<typeof BaseEventSchema>;

// ============================================================================
// SAGA LIFECYCLE EVENTS
// Track saga execution state
// ============================================================================

export const SagaStartedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("SAGA_STARTED"),
  payload: z.object({
    executionId: z.string().uuid(),
    intentId: z.string().uuid().optional(),
    planId: z.string().uuid().optional(),
    planSummary: z.string(),
    totalSteps: z.number().int().positive(),
    estimatedDurationMs: z.number().int().positive().optional(),
  }),
});

export const SagaStepStartedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("SAGA_STEP_STARTED"),
  payload: z.object({
    executionId: z.string().uuid(),
    stepId: z.string().uuid(),
    stepIndex: z.number().int().nonnegative(),
    toolName: z.string(),
    parameters: z.record(z.string(), z.unknown()),
  }),
});

export const SagaStepCompletedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("SAGA_STEP_COMPLETED"),
  payload: z.object({
    executionId: z.string().uuid(),
    stepId: z.string().uuid(),
    stepIndex: z.number().int().nonnegative(),
    toolName: z.string(),
    output: z.unknown(),
    latencyMs: z.number().int().nonnegative(),
  }),
});

export const SagaStepFailedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("SAGA_STEP_FAILED"),
  payload: z.object({
    executionId: z.string().uuid(),
    stepId: z.string().uuid(),
    stepIndex: z.number().int().nonnegative(),
    toolName: z.string(),
    error: z.object({
      code: z.string(),
      message: z.string(),
      recoverable: z.boolean().optional(),
    }),
    compensationRequired: z.boolean(),
  }),
});

export const SagaYieldedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("SAGA_YIELDED"),
  payload: z.object({
    executionId: z.string().uuid(),
    reason: z.enum(["TIMEOUT_APPROACHING", "AWAITING_CONFIRMATION", "ERROR_RECOVERY"]),
    nextStepIndex: z.number().int().nonnegative(),
    segmentNumber: z.number().int().positive(),
    checkpointKey: z.string(),
  }),
});

export const SagaResumedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("SAGA_RESUMED"),
  payload: z.object({
    executionId: z.string().uuid(),
    segmentNumber: z.number().int().positive(),
    resumedFrom: z.string(), // Checkpoint key
    elapsedMs: z.number().int().nonnegative(),
  }),
});

export const SagaCompletedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("SAGA_COMPLETED"),
  payload: z.object({
    executionId: z.string().uuid(),
    success: z.boolean(),
    totalSteps: z.number().int().positive(),
    completedSteps: z.number().int().nonnegative(),
    failedSteps: z.number().int().nonnegative(),
    totalDurationMs: z.number().int().positive(),
    summary: z.string(),
  }),
});

export const SagaCompensatedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("SAGA_COMPENSATED"),
  payload: z.object({
    executionId: z.string().uuid(),
    compensatedSteps: z.array(z.object({
      stepId: z.string().uuid(),
      compensationTool: z.string(),
      success: z.boolean(),
      latencyMs: z.number().int().nonnegative(),
    })),
    totalCompensationDurationMs: z.number().int().positive(),
  }),
});

export const SagaFailedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("SAGA_FAILED"),
  payload: z.object({
    executionId: z.string().uuid(),
    error: z.object({
      code: z.string(),
      message: z.string(),
      stepId: z.string().uuid().optional(),
    }),
    compensationAttempted: z.boolean(),
    compensationSuccessful: z.boolean().optional(),
  }),
});

// ============================================================================
// TABLE MANAGEMENT EVENTS
// Real-time table state changes
// ============================================================================

export const TableVacatedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("TABLE_VACATED"),
  payload: z.object({
    restaurantId: z.string().uuid(),
    tableId: z.string().uuid(),
    tableName: z.string(),
    vacatedAt: z.string().datetime(),
    previousReservationId: z.string().uuid().optional(),
    turnoverTimeMinutes: z.number().int().nonnegative().optional(),
  }),
});

export type TableVacatedEvent = z.infer<typeof TableVacatedEventSchema>;

export const TableSeatedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("TABLE_SEATED"),
  payload: z.object({
    restaurantId: z.string().uuid(),
    tableId: z.string().uuid(),
    tableName: z.string(),
    seatedAt: z.string().datetime(),
    reservationId: z.string().uuid().optional(),
    partySize: z.number().int().positive(),
  }),
});

export const TableStatusChangedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("TABLE_STATUS_CHANGED"),
  payload: z.object({
    restaurantId: z.string().uuid(),
    tableId: z.string().uuid(),
    tableName: z.string(),
    previousStatus: z.enum(["available", "occupied", "reserved", "maintenance"]),
    newStatus: z.enum(["available", "occupied", "reserved", "maintenance"]),
    changedAt: z.string().datetime(),
    reason: z.string().optional(),
  }),
});

export const ReservationCreatedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("RESERVATION_CREATED"),
  payload: z.object({
    restaurantId: z.string().uuid(),
    reservationId: z.string().uuid(),
    tableId: z.string().uuid().optional(),
    partySize: z.number().int().positive(),
    reservationTime: z.string().datetime(),
    guestName: z.string(),
    guestEmail: z.string().email(),
    guestPhone: z.string().optional(),
  }),
});

export const ReservationCancelledEventSchema = BaseEventSchema.extend({
  eventType: z.literal("RESERVATION_CANCELLED"),
  payload: z.object({
    restaurantId: z.string().uuid(),
    reservationId: z.string().uuid(),
    cancelledAt: z.string().datetime(),
    reason: z.string(),
    refundIssued: z.boolean().optional(),
  }),
});

// ============================================================================
// DELIVERY FULFILLMENT EVENTS
// Real-time delivery state changes
// ============================================================================

export const DeliveryDispatchedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("DELIVERY_DISPATCHED"),
  payload: z.object({
    fulfillmentId: z.string().uuid(),
    orderId: z.string().uuid(),
    driverId: z.string().uuid(),
    restaurantId: z.string().uuid(),
    dispatchedAt: z.string().datetime(),
    estimatedPickupTime: z.string().datetime(),
    estimatedDeliveryTime: z.string().datetime(),
  }),
});

export const DriverArrivedAtPickupEventSchema = BaseEventSchema.extend({
  eventType: z.literal("DRIVER_ARRIVED_AT_PICKUP"),
  payload: z.object({
    fulfillmentId: z.string().uuid(),
    driverId: z.string().uuid(),
    restaurantId: z.string().uuid(),
    arrivedAt: z.string().datetime(),
  }),
});

export const DriverPickedUpOrderEventSchema = BaseEventSchema.extend({
  eventType: z.literal("DRIVER_PICKED_UP_ORDER"),
  payload: z.object({
    fulfillmentId: z.string().uuid(),
    driverId: z.string().uuid(),
    orderId: z.string().uuid(),
    pickedUpAt: z.string().datetime(),
  }),
});

export const DriverArrivedAtDeliveryEventSchema = BaseEventSchema.extend({
  eventType: z.literal("DRIVER_ARRIVED_AT_DELIVERY"),
  payload: z.object({
    fulfillmentId: z.string().uuid(),
    driverId: z.string().uuid(),
    orderId: z.string().uuid(),
    arrivedAt: z.string().datetime(),
  }),
});

export const DeliveryCompletedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("DELIVERY_COMPLETED"),
  payload: z.object({
    fulfillmentId: z.string().uuid(),
    orderId: z.string().uuid(),
    driverId: z.string().uuid(),
    completedAt: z.string().datetime(),
    totalDurationMinutes: z.number().int().positive(),
  }),
});

export const DeliveryFailedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("DELIVERY_FAILED"),
  payload: z.object({
    fulfillmentId: z.string().uuid(),
    orderId: z.string().uuid(),
    driverId: z.string().uuid(),
    failedAt: z.string().datetime(),
    reason: z.string(),
    refundIssued: z.boolean().optional(),
  }),
});

// ============================================================================
// INTENT LIFECYCLE EVENTS
// Track user intent processing
// ============================================================================

export const IntentReceivedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("INTENT_RECEIVED"),
  payload: z.object({
    intentId: z.string().uuid(),
    executionId: z.string().uuid(),
    rawText: z.string(),
    intentType: z.string(),
    confidence: z.number().min(0).max(1),
  }),
});

export const IntentClarificationRequiredEventSchema = BaseEventSchema.extend({
  eventType: z.literal("INTENT_CLARIFICATION_REQUIRED"),
  payload: z.object({
    intentId: z.string().uuid(),
    executionId: z.string().uuid(),
    clarificationPrompt: z.string(),
    missingParameters: z.array(z.string()),
  }),
});

export const IntentResolvedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("INTENT_RESOLVED"),
  payload: z.object({
    intentId: z.string().uuid(),
    executionId: z.string().uuid(),
    resolvedParameters: z.record(z.string(), z.unknown()),
  }),
});

// ============================================================================
// SYSTEM HEALTH EVENTS
// Infrastructure monitoring
// ============================================================================

export const CircuitBreakerTrippedEventSchema = BaseEventSchema.extend({
  eventType: z.literal("CIRCUIT_BREAKER_TRIPPED"),
  payload: z.object({
    stepId: z.string().uuid(),
    toolName: z.string(),
    executionId: z.string().uuid(),
    failureCount: z.number().int().positive(),
    windowMs: z.number().int().positive(),
    trippedAt: z.string().datetime(),
  }),
});

export const CircuitBreakerResetEventSchema = BaseEventSchema.extend({
  eventType: z.literal("CIRCUIT_BREAKER_RESET"),
  payload: z.object({
    stepId: z.string().uuid(),
    toolName: z.string(),
    executionId: z.string().uuid(),
    resetAt: z.string().datetime(),
  }),
});

export const BudgetExceededEventSchema = BaseEventSchema.extend({
  eventType: z.literal("BUDGET_EXCEEDED"),
  payload: z.object({
    executionId: z.string().uuid(),
    budgetLimit: z.number().positive(),
    currentCost: z.number().positive(),
    exceededAt: z.string().datetime(),
  }),
});

export const RateLimitExceededEventSchema = BaseEventSchema.extend({
  eventType: z.literal("RATE_LIMIT_EXCEEDED"),
  payload: z.object({
    service: z.string(),
    limitType: z.string(),
    limitValue: z.number().int().positive(),
    currentValue: z.number().int().positive(),
    retryAfterMs: z.number().int().positive(),
  }),
});

// ============================================================================
// UNION SCHEMA - All Nervous System Events
// ============================================================================

export const NervousSystemEventSchema = z.discriminatedUnion("eventType", [
  // Saga lifecycle
  SagaStartedEventSchema,
  SagaStepStartedEventSchema,
  SagaStepCompletedEventSchema,
  SagaStepFailedEventSchema,
  SagaYieldedEventSchema,
  SagaResumedEventSchema,
  SagaCompletedEventSchema,
  SagaCompensatedEventSchema,
  SagaFailedEventSchema,
  // Table management
  TableVacatedEventSchema,
  TableSeatedEventSchema,
  TableStatusChangedEventSchema,
  ReservationCreatedEventSchema,
  ReservationCancelledEventSchema,
  // Delivery fulfillment
  DeliveryDispatchedEventSchema,
  DriverArrivedAtPickupEventSchema,
  DriverPickedUpOrderEventSchema,
  DriverArrivedAtDeliveryEventSchema,
  DeliveryCompletedEventSchema,
  DeliveryFailedEventSchema,
  // Intent lifecycle
  IntentReceivedEventSchema,
  IntentClarificationRequiredEventSchema,
  IntentResolvedEventSchema,
  // System health
  CircuitBreakerTrippedEventSchema,
  CircuitBreakerResetEventSchema,
  BudgetExceededEventSchema,
  RateLimitExceededEventSchema,
]);

export type NervousSystemEvent = z.infer<typeof NervousSystemEventSchema>;

// ============================================================================
// EVENT TYPE ENUM
// For easy reference
// ============================================================================

export const NervousSystemEventTypeSchema = z.enum([
  "SAGA_STARTED",
  "SAGA_STEP_STARTED",
  "SAGA_STEP_COMPLETED",
  "SAGA_STEP_FAILED",
  "SAGA_YIELDED",
  "SAGA_RESUMED",
  "SAGA_COMPLETED",
  "SAGA_COMPENSATED",
  "SAGA_FAILED",
  "TABLE_VACATED",
  "TABLE_SEATED",
  "TABLE_STATUS_CHANGED",
  "RESERVATION_CREATED",
  "RESERVATION_CANCELLED",
  "DELIVERY_DISPATCHED",
  "DRIVER_ARRIVED_AT_PICKUP",
  "DRIVER_PICKED_UP_ORDER",
  "DRIVER_ARRIVED_AT_DELIVERY",
  "DELIVERY_COMPLETED",
  "DELIVERY_FAILED",
  "INTENT_RECEIVED",
  "INTENT_CLARIFICATION_REQUIRED",
  "INTENT_RESOLVED",
  "CIRCUIT_BREAKER_TRIPPED",
  "CIRCUIT_BREAKER_RESET",
  "BUDGET_EXCEEDED",
  "RATE_LIMIT_EXCEEDED",
]);

export type NervousSystemEventType = z.infer<typeof NervousSystemEventTypeSchema>;

// ============================================================================
// EVENT SCHEMA REGISTRY
// Runtime registry for event validation
// ============================================================================

export type SchemaValidator<T = unknown> = (data: unknown) => { success: boolean; data?: T; error?: string };

export class EventSchemaRegistry {
  private schemas: Map<string, z.ZodSchema> = new Map();
  private validators: Map<string, SchemaValidator> = new Map();

  constructor() {
    // Register all built-in schemas
    this.registerBuiltInSchemas();
  }

  /**
   * Register all built-in nervous system schemas
   */
  private registerBuiltInSchemas(): void {
    const schemas: Array<[string, z.ZodSchema]> = [
      // Saga lifecycle
      ["saga_started:v1", SagaStartedEventSchema],
      ["saga_step_started:v1", SagaStepStartedEventSchema],
      ["saga_step_completed:v1", SagaStepCompletedEventSchema],
      ["saga_step_failed:v1", SagaStepFailedEventSchema],
      ["saga_yielded:v1", SagaYieldedEventSchema],
      ["saga_resumed:v1", SagaResumedEventSchema],
      ["saga_completed:v1", SagaCompletedEventSchema],
      ["saga_compensated:v1", SagaCompensatedEventSchema],
      ["saga_failed:v1", SagaFailedEventSchema],
      // Table management
      ["table_vacated:v1", TableVacatedEventSchema],
      ["table_seated:v1", TableSeatedEventSchema],
      ["table_status_changed:v1", TableStatusChangedEventSchema],
      ["reservation_created:v1", ReservationCreatedEventSchema],
      ["reservation_cancelled:v1", ReservationCancelledEventSchema],
      // Delivery fulfillment
      ["delivery_dispatched:v1", DeliveryDispatchedEventSchema],
      ["driver_arrived_at_pickup:v1", DriverArrivedAtPickupEventSchema],
      ["driver_picked_up_order:v1", DriverPickedUpOrderEventSchema],
      ["driver_arrived_at_delivery:v1", DriverArrivedAtDeliveryEventSchema],
      ["delivery_completed:v1", DeliveryCompletedEventSchema],
      ["delivery_failed:v1", DeliveryFailedEventSchema],
      // Intent lifecycle
      ["intent_received:v1", IntentReceivedEventSchema],
      ["intent_clarification_required:v1", IntentClarificationRequiredEventSchema],
      ["intent_resolved:v1", IntentResolvedEventSchema],
      // System health
      ["circuit_breaker_tripped:v1", CircuitBreakerTrippedEventSchema],
      ["circuit_breaker_reset:v1", CircuitBreakerResetEventSchema],
      ["budget_exceeded:v1", BudgetExceededEventSchema],
      ["rate_limit_exceeded:v1", RateLimitExceededEventSchema],
    ];

    for (const [key, schema] of schemas) {
      this.register(key, schema);
    }
  }

  /**
   * Register a new event schema
   */
  register<T extends z.ZodSchema>(eventType: string, schema: T, version: string = "v1"): void {
    const key = `${eventType}:${version}`;
    this.schemas.set(key, schema);

    // Create validator function
    const validator: SchemaValidator<z.infer<T>> = (data: unknown) => {
      const result = schema.safeParse(data);
      if (result.success) {
        return { success: true, data: result.data };
      } else {
        return {
          success: false,
          error: result.error.errors.map(e => `${e.path.join(".")}: ${e.message}`).join("; "),
        };
      }
    };

    this.validators.set(key, validator);
    console.log(`[EventSchemaRegistry] Registered schema: ${key}`);
  }

  /**
   * Validate an event against its schema
   */
  validate<T = unknown>(eventType: string, data: unknown, version: string = "v1"): { success: boolean; data?: T; error?: string } {
    const key = `${eventType}:${version}`;
    const validator = this.validators.get(key);

    if (!validator) {
      return {
        success: false,
        error: `No schema registered for ${key}`,
      };
    }

    return validator(data) as { success: boolean; data?: T; error?: string };
  }

  /**
   * Get a schema by event type and version
   */
  getSchema(eventType: string, version: string = "v1"): z.ZodSchema | undefined {
    const key = `${eventType}:${version}`;
    return this.schemas.get(key);
  }

  /**
   * List all registered event types
   */
  listEventTypes(): string[] {
    return Array.from(this.schemas.keys());
  }

  /**
   * Check if an event type is registered
   */
  isRegistered(eventType: string, version: string = "v1"): boolean {
    const key = `${eventType}:${version}`;
    return this.schemas.has(key);
  }
}

// ============================================================================
// SINGLETON INSTANCE
// Export a shared registry instance
// ============================================================================

export const eventSchemaRegistry = new EventSchemaRegistry();

/**
 * Get the singleton event schema registry
 */
export function getEventSchemaRegistry(): EventSchemaRegistry {
  return eventSchemaRegistry;
}
