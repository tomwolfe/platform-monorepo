/**
 * Type-safe event payloads for Ably real-time events.
 * 
 * This module defines strict interfaces for all Ably message payloads
 * to prevent type safety leaks and ensure consistent event handling.
 * 
 * Usage:
 * ```typescript
 * channel.subscribe('delivery_dispatched', (message) => {
 *   const data = message.data as DeliveryDispatchedPayload;
 *   // data is now fully typed
 * });
 * ```
 */

/**
 * Base interface for all Ably message data payloads.
 * All event-specific payloads should extend this interface.
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
 * Payload for delivery_dispatched events.
 * Emitted when a delivery driver has been assigned and dispatched to pickup an order.
 */
export interface DeliveryDispatchedPayload extends AblyMessageData {
  /** The order ID being dispatched */
  order_id: string;
  /** Driver ID assigned to the delivery (optional for backward compatibility) */
  driver_id?: string;
  /** Estimated pickup time (ISO 8601) */
  estimated_pickup_time?: string;
  /** Restaurant ID where pickup will occur */
  restaurant_id?: string;
}

/**
 * Payload for reservation_created events.
 * Emitted when a new reservation is created in the system.
 */
export interface ReservationCreatedPayload extends AblyMessageData {
  /** The reservation ID */
  reservation_id: string;
  /** Restaurant ID */
  restaurant_id: string;
  /** Guest name */
  guest_name: string;
  /** Party size */
  party_size: number;
  /** Reservation start time (ISO 8601) */
  start_time: string;
  /** Table ID if assigned */
  table_id?: string;
}

/**
 * Payload for table_status_changed events.
 * Emitted when a table's status changes (vacant/occupied/dirty).
 */
export interface TableStatusChangedPayload extends AblyMessageData {
  /** The table ID */
  table_id: string;
  /** Restaurant ID */
  restaurant_id: string;
  /** New status */
  status: 'vacant' | 'occupied' | 'dirty';
  /** Previous status */
  previous_status?: 'vacant' | 'occupied' | 'dirty';
}

/**
 * Payload for waitlist_updated events.
 * Emitted when a guest is added or removed from the waitlist.
 */
export interface WaitlistUpdatedPayload extends AblyMessageData {
  /** Restaurant ID */
  restaurant_id: string;
  /** Waitlist entry ID */
  entry_id?: string;
  /** New status */
  status: 'waiting' | 'notified' | 'seated' | 'cancelled';
  /** Action performed */
  action: 'added' | 'removed' | 'updated';
}

/**
 * Union type of all known Ably event payloads.
 * Use this for generic event handlers that process multiple event types.
 */
export type AblyEventPayload =
  | DeliveryDispatchedPayload
  | ReservationCreatedPayload
  | TableStatusChangedPayload
  | WaitlistUpdatedPayload;

/**
 * Type guard to check if a payload is a DeliveryDispatchedPayload.
 */
export function isDeliveryDispatchedPayload(
  data: unknown
): data is DeliveryDispatchedPayload {
  return (
    typeof data === 'object' &&
    data !== null &&
    'order_id' in data &&
    typeof (data as DeliveryDispatchedPayload).order_id === 'string'
  );
}

/**
 * Type guard to check if a payload is a ReservationCreatedPayload.
 */
export function isReservationCreatedPayload(
  data: unknown
): data is ReservationCreatedPayload {
  return (
    typeof data === 'object' &&
    data !== null &&
    'reservation_id' in data &&
    'restaurant_id' in data &&
    'guest_name' in data &&
    'party_size' in data
  );
}

/**
 * Type guard to check if a payload is a TableStatusChangedPayload.
 */
export function isTableStatusChangedPayload(
  data: unknown
): data is TableStatusChangedPayload {
  return (
    typeof data === 'object' &&
    data !== null &&
    'table_id' in data &&
    'status' in data &&
    ['vacant', 'occupied', 'dirty'].includes((data as TableStatusChangedPayload).status)
  );
}

/**
 * Type guard to check if a payload is a WaitlistUpdatedPayload.
 */
export function isWaitlistUpdatedPayload(
  data: unknown
): data is WaitlistUpdatedPayload {
  return (
    typeof data === 'object' &&
    data !== null &&
    'restaurant_id' in data &&
    'status' in data &&
    'action' in data
  );
}
