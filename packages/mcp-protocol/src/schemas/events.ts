import { z } from "zod";

/**
 * SystemEvent Schema - Phase 2: Formalize Event Backbone
 * 
 * All domain events published to the Nervous System mesh must conform to this schema.
 * Ensures consistent event structure, traceability, and versioning across services.
 */

/**
 * Core event types representing domain state changes.
 * Extend this union as new event types are added.
 */
export const SystemEventTypeSchema = z.enum([
  // Reservation Events
  "ReservationCreated",
  "ReservationConfirmed",
  "ReservationCancelled",
  "ReservationUpdated",
  "ReservationRejected",
  
  // Waitlist Events
  "WaitlistEntryAdded",
  "WaitlistEntryUpdated",
  "WaitlistEntrySeated",
  "WaitlistEntryRemoved",
  
  // Delivery Events
  "DeliveryQuoteRequested",
  "DeliveryDispatched",
  "DeliveryInProgress",
  "DeliveryCompleted",
  "DeliveryCancelled",
  "DeliveryFailed",
  
  // Table Events
  "TableVacated",
  "TableOccupied",
  "TableCombined",
  "TableSplit",
  
  // Guest Events
  "HighValueGuestReservation",
  "GuestProfileCreated",
  "GuestProfileUpdated",
  
  // Restaurant Events
  "RestaurantClaimed",
  "RestaurantShadowCreated",
  "RestaurantOperationalStateChanged",
  
  // System Events
  "IntentInferred",
  "PlanGenerated",
  "PlanExecutionStarted",
  "PlanExecutionCompleted",
  "PlanExecutionFailed",
  "SagaStarted",
  "SagaCompleted",
  "SagaCompensated",
  "CircuitBreakerOpened",
  "CircuitBreakerClosed",
]);

export type SystemEventType = z.infer<typeof SystemEventTypeSchema>;

/**
 * Event payload - flexible record type validated per event type.
 * Specific payload schemas should be defined separately and composed.
 */
export const EventPayloadSchema = z.record(z.unknown());

/**
 * SystemEvent - The canonical event structure for the Nervous System.
 */
export const SystemEventSchema = z.object({
  /** Unique event identifier */
  id: z.string().uuid().describe("Unique event identifier"),
  
  /** Event type from the controlled vocabulary */
  type: SystemEventTypeSchema.describe("Event type from controlled vocabulary"),
  
  /** Event payload - type-specific data */
  payload: EventPayloadSchema.describe("Event payload - type-specific data"),
  
  /** Distributed trace ID for observability correlation */
  traceId: z.string().optional().describe("Distributed trace ID for observability"),
  
  /** Schema version for backward compatibility */
  version: z.string().default("1.0.0").describe("Schema version for backward compatibility"),
  
  /** ISO 8601 timestamp of event creation */
  timestamp: z.string().datetime().describe("ISO 8601 timestamp of event creation"),
  
  /** Source service name (e.g., 'table-stack', 'open-delivery', 'intention-engine') */
  source: z.string().describe("Source service name"),
  
  /** Optional correlation ID for linking related events */
  correlationId: z.string().optional().describe("Correlation ID for linking related events"),
  
  /** Optional causation ID linking to the event that caused this one */
  causationId: z.string().optional().describe("Causation ID - links to causing event"),
  
  /** Optional metadata for extensibility */
  metadata: z.record(z.unknown()).optional().describe("Optional metadata for extensibility"),
});

export type SystemEvent = z.infer<typeof SystemEventSchema>;

/**
 * Helper to create a SystemEvent with defaults.
 */
export function createSystemEvent(
  type: SystemEventType,
  payload: Record<string, unknown>,
  source: string,
  options: {
    traceId?: string;
    correlationId?: string;
    causationId?: string;
    metadata?: Record<string, unknown>;
    version?: string;
  } = {}
): SystemEvent {
  return SystemEventSchema.parse({
    id: crypto.randomUUID(),
    type,
    payload,
    source,
    timestamp: new Date().toISOString(),
    version: options.version ?? "1.0.0",
    traceId: options.traceId,
    correlationId: options.correlationId,
    causationId: options.causationId,
    metadata: options.metadata,
  });
}

/**
 * Event Envelope for Ably publish/subscribe.
 * Wraps SystemEvent with authentication token.
 */
export const EventEnvelopeSchema = z.object({
  /** The system event being published */
  event: SystemEventSchema,
  
  /** Service authentication token */
  token: z.string().describe("Service authentication token"),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/**
 * Domain Event Specific Schemas
 * These define the payload structure for each event type.
 */

// ============================================================================
// RESERVATION EVENTS
// ============================================================================

export const ReservationEventPayloadSchema = z.object({
  reservationId: z.string().uuid(),
  restaurantId: z.string().uuid(),
  restaurantName: z.string(),
  guestName: z.string(),
  guestEmail: z.string(),
  partySize: z.number().int().positive(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  tableId: z.string().uuid().optional(),
  combinedTableIds: z.array(z.string().uuid()).optional(),
  status: z.enum(["pending", "confirmed", "verified", "cancelled", "completed"]),
  isShadow: z.boolean().default(false),
});

export type ReservationEventPayload = z.infer<typeof ReservationEventPayloadSchema>;

// ============================================================================
// DELIVERY EVENTS
// ============================================================================

export const DeliveryEventPayloadSchema = z.object({
  orderId: z.string().uuid(),
  restaurantId: z.string().uuid(),
  restaurantName: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  customerEmail: z.string().optional(),
  pickupAddress: z.string(),
  deliveryAddress: z.string(),
  status: z.enum(["quote_requested", "dispatched", "in_progress", "completed", "cancelled", "failed"]),
  priceDetails: z.object({
    basePay: z.number(),
    tip: z.number(),
    total: z.number(),
  }).optional(),
  driverId: z.string().optional(),
  estimatedDeliveryTime: z.string().datetime().optional(),
});

export type DeliveryEventPayload = z.infer<typeof DeliveryEventPayloadSchema>;

// ============================================================================
// GUEST EVENTS
// ============================================================================

export const HighValueGuestEventPayloadSchema = z.object({
  guest: z.object({
    name: z.string(),
    email: z.string().email(),
    visitCount: z.number().int().positive(),
    defaultDeliveryAddress: z.string().optional(),
    preferences: z.record(z.unknown()).optional(),
  }),
  reservation: z.object({
    id: z.string().uuid(),
    restaurantName: z.string(),
    startTime: z.string().datetime(),
    partySize: z.number().int().positive(),
  }),
});

export type HighValueGuestEventPayload = z.infer<typeof HighValueGuestEventPayloadSchema>;

// ============================================================================
// SAGA EVENTS
// ============================================================================

export const SagaEventPayloadSchema = z.object({
  sagaId: z.string().uuid(),
  executionId: z.string(),
  intentId: z.string().optional(),
  steps: z.array(z.object({
    id: z.string(),
    toolName: z.string(),
    status: z.enum(["pending", "completed", "failed", "compensating", "compensated"]),
  })),
  currentStep: z.number().int().nonnegative().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    stepId: z.string().optional(),
  }).optional(),
});

export type SagaEventPayload = z.infer<typeof SagaEventPayloadSchema>;

// ============================================================================
// CIRCUIT BREAKER EVENTS
// ============================================================================

export const CircuitBreakerEventPayloadSchema = z.object({
  serviceName: z.string(),
  serverUrl: z.string(),
  state: z.enum(["CLOSED", "OPEN", "HALF_OPEN"]),
  failureCount: z.number().int().nonnegative(),
  lastFailureTime: z.string().datetime().optional(),
  reason: z.string().optional(),
});

export type CircuitBreakerEventPayload = z.infer<typeof CircuitBreakerEventPayloadSchema>;

/**
 * Payload Type Discriminator Union
 * Maps event types to their payload schemas.
 */
export type EventPayloadByType = {
  ReservationCreated: ReservationEventPayload;
  ReservationConfirmed: ReservationEventPayload;
  ReservationCancelled: ReservationEventPayload;
  ReservationUpdated: ReservationEventPayload;
  ReservationRejected: ReservationEventPayload;
  DeliveryDispatched: DeliveryEventPayload;
  DeliveryInProgress: DeliveryEventPayload;
  DeliveryCompleted: DeliveryEventPayload;
  DeliveryCancelled: DeliveryEventPayload;
  DeliveryFailed: DeliveryEventPayload;
  HighValueGuestReservation: HighValueGuestEventPayload;
  TableVacated: { tableId: string; restaurantId: string; timestamp: string };
  SagaStarted: SagaEventPayload;
  SagaCompleted: SagaEventPayload;
  SagaCompensated: SagaEventPayload;
  CircuitBreakerOpened: CircuitBreakerEventPayload;
  CircuitBreakerClosed: CircuitBreakerEventPayload;
};

/**
 * Type-safe event factory for specific event types.
 */
export function createTypedSystemEvent<T extends keyof EventPayloadByType>(
  type: T,
  payload: EventPayloadByType[T],
  source: string,
  options?: {
    traceId?: string;
    correlationId?: string;
    causationId?: string;
    metadata?: Record<string, unknown>;
  }
): SystemEvent & { payload: EventPayloadByType[T] } {
  return createSystemEvent(type as SystemEventType, payload as Record<string, unknown>, source, options) as SystemEvent & { payload: EventPayloadByType[T] };
}
