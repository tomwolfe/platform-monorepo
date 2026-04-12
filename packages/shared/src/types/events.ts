/**
 * Type-safe event payloads for Ably real-time events.
 *
 * This module re-exports event types inferred from Zod schemas defined in
 * @repo/mcp-protocol/src/schemas/events.ts to ensure runtime validation
 * and compile-time typings never drift.
 *
 * Usage:
 * ```typescript
 * import { DeliveryEventPayload, SystemEvent } from '@repo/shared/types/events';
 * ```
 *
 * @see @repo/mcp-protocol/src/schemas/events.ts for source schemas
 */

import { z } from "zod";
import {
  SystemEventSchema,
  DeliveryEventPayloadSchema,
  ReservationEventPayloadSchema,
  SagaEventPayloadSchema,
  CircuitBreakerEventPayloadSchema,
  HighValueGuestEventPayloadSchema,
  type SystemEvent as MCPSystemEvent,
  type DeliveryEventPayload as MCPDeliveryEventPayload,
  type ReservationEventPayload as MCPReservationEventPayload,
  type SagaEventPayload as MCPSagaEventPayload,
  type CircuitBreakerEventPayload as MCPCircuitBreakerEventPayload,
  type HighValueGuestEventPayload as MCPHighValueGuestEventPayload,
  type EventPayloadByType,
  createSystemEvent,
  createTypedSystemEvent,
} from "@repo/mcp-protocol";

// ============================================================================
// Re-export core system event types
// ============================================================================

export {
  SystemEventSchema,
  DeliveryEventPayloadSchema,
  ReservationEventPayloadSchema,
  SagaEventPayloadSchema,
  CircuitBreakerEventPayloadSchema,
  HighValueGuestEventPayloadSchema,
  EventPayloadByType,
  createSystemEvent,
  createTypedSystemEvent,
};

/**
 * SystemEvent type - inferred from Zod schema
 */
export type SystemEvent = MCPSystemEvent;

/**
 * DeliveryEventPayload - inferred from Zod schema
 */
export type DeliveryEventPayload = MCPDeliveryEventPayload;

/**
 * ReservationEventPayload - inferred from Zod schema
 */
export type ReservationEventPayload = MCPReservationEventPayload;

/**
 * SagaEventPayload - inferred from Zod schema
 */
export type SagaEventPayload = MCPSagaEventPayload;

/**
 * CircuitBreakerEventPayload - inferred from Zod schema
 */
export type CircuitBreakerEventPayload = MCPCircuitBreakerEventPayload;

/**
 * HighValueGuestEventPayload - inferred from Zod schema
 */
export type HighValueGuestEventPayload = MCPHighValueGuestEventPayload;

// ============================================================================
// Backward Compatibility Aliases
// These aliases maintain compatibility with existing code while migrating
// to the new schema-inferred types.
// ============================================================================

/**
 * @deprecated Use DeliveryEventPayload instead
 * Base interface for all Ably message data payloads.
 */
export interface AblyMessageData {
  /** Unique identifier for the event */
  event_id?: string;
  /** Timestamp when the event was created (ISO 8601) */
  timestamp?: string;
  /** Source service that emitted the event */
  source?: string;
}

/**
 * @deprecated Use DeliveryEventPayload instead
 * Payload for delivery_dispatched events.
 */
export type DeliveryDispatchedPayload = DeliveryEventPayload;

/**
 * @deprecated Use ReservationEventPayload instead
 * Payload for reservation_created events.
 */
export type ReservationCreatedPayload = ReservationEventPayload;

/**
 * Type guard to check if a payload is a DeliveryDispatchedPayload.
 */
export function isDeliveryDispatchedPayload(
  data: unknown,
): data is DeliveryDispatchedPayload {
  return (
    typeof data === "object" &&
    data !== null &&
    "orderId" in data &&
    typeof (data as DeliveryDispatchedPayload).orderId === "string"
  );
}

/**
 * Type guard to check if a payload is a ReservationCreatedPayload.
 */
export function isReservationCreatedPayload(
  data: unknown,
): data is ReservationCreatedPayload {
  return (
    typeof data === "object" &&
    data !== null &&
    "reservationId" in data &&
    "restaurantId" in data &&
    "guestName" in data &&
    "partySize" in data
  );
}

/**
 * Payload for table_status_changed events.
 * Note: This is a local type that doesn't exist in MCP protocol yet.
 */
export interface TableStatusChangedPayload extends AblyMessageData {
  /** The table ID */
  table_id: string;
  /** Restaurant ID */
  restaurant_id: string;
  /** New status */
  status: "vacant" | "occupied" | "dirty";
  /** Previous status */
  previous_status?: "vacant" | "occupied" | "dirty";
}

/**
 * Payload for waitlist_updated events.
 * Note: This is a local type that doesn't exist in MCP protocol yet.
 */
export interface WaitlistUpdatedPayload extends AblyMessageData {
  /** Restaurant ID */
  restaurant_id: string;
  /** Waitlist entry ID */
  entry_id?: string;
  /** New status */
  status: "waiting" | "notified" | "seated" | "cancelled";
  /** Action performed */
  action: "added" | "removed" | "updated";
}

/**
 * Type guard to check if a payload is a TableStatusChangedPayload.
 */
export function isTableStatusChangedPayload(
  data: unknown,
): data is TableStatusChangedPayload {
  return (
    typeof data === "object" &&
    data !== null &&
    "table_id" in data &&
    "status" in data &&
    ["vacant", "occupied", "dirty"].includes(
      (data as TableStatusChangedPayload).status,
    )
  );
}

/**
 * Type guard to check if a payload is a WaitlistUpdatedPayload.
 */
export function isWaitlistUpdatedPayload(
  data: unknown,
): data is WaitlistUpdatedPayload {
  return (
    typeof data === "object" &&
    data !== null &&
    "restaurant_id" in data &&
    "status" in data &&
    "action" in data
  );
}

/**
 * Union type of all known Ably event payloads.
 */
export type AblyEventPayload =
  | DeliveryDispatchedPayload
  | ReservationCreatedPayload
  | TableStatusChangedPayload
  | WaitlistUpdatedPayload;
