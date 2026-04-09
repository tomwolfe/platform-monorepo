/**
 * Compensating Actions Registry - Phase 3: Saga Patterns
 *
 * Defines the compensation (undo) action for each tool that modifies state.
 * Used by SagaManager to automatically roll back changes on failure.
 *
 * CRITICAL: Every state-modifying tool MUST have a compensation entry.
 * If a tool cannot be compensated, it must be marked with an empty toolName
 * and documented why compensation is not possible.
 */

import { ToolInput } from "../index";

export interface CompensationDefinition {
  /** The tool name to execute for compensation */
  toolName: string;
  /** How to map parameters from the original step to the compensation */
  parameterMapper:
    | "use_booking_id"
    | "use_order_id"
    | "use_reservation_id"
    | "use_fulfillment_id"
    | "use_ride_id"
    | "identity";
  /** Whether the compensation requires confirmation (should be false for auto-compensation) */
  requiresConfirmation: boolean;
  /** Optional: Custom parameter mapping function for complex compensations */
  customMapper?: (
    originalParams: Record<string, unknown>,
    stepResult?: unknown,
  ) => Record<string, unknown>;
}

// Strict type for original parameters with known fields
interface OriginalParams {
  reservationId?: string;
  waitlistId?: string;
  order_id?: string;
  pickup_location?: string;
  destination_location?: string;
  service?: string;
  [key: string]: unknown;
}

// Strict type for step results with known fields
interface StepResult {
  booking_id?: string;
  fulfillmentId?: string;
  ride_id?: string;
  order_id?: string;
  /** Pre-mutation state snapshot for update operations (captured before mutation) */
  preMutationState?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Maps each tool to its compensating action.
 * Keys are tool names, values define how to undo the action.
 */
export const COMPENSATIONS: Record<string, CompensationDefinition> = {
  // ============================================================================
  // RESERVATION COMPENSATIONS
  // ============================================================================

  create_reservation: {
    toolName: "cancel_reservation",
    parameterMapper: "use_reservation_id",
    requiresConfirmation: false,
  },

  bookTable: {
    toolName: "cancel_reservation",
    parameterMapper: "use_booking_id",
    requiresConfirmation: false,
  },

  book_tablestack_reservation: {
    toolName: "cancel_reservation",
    parameterMapper: "use_booking_id",
    requiresConfirmation: false,
  },

  update_reservation: {
    toolName: "update_reservation",
    parameterMapper: "use_reservation_id",
    requiresConfirmation: false,
    // Restores the pre-mutation state captured in the step result
    customMapper: (originalParams: OriginalParams, stepResult?: StepResult) => {
      // Use the pre-mutation state snapshot to restore exact previous state
      if (stepResult?.preMutationState) {
        return {
          reservationId: originalParams.reservationId,
          ...stepResult.preMutationState,
        };
      }
      // Fallback: if no snapshot available, log warning and return minimal restore params
      return { reservationId: originalParams.reservationId };
    },
  },

  reserve_restaurant: {
    toolName: "cancel_reservation",
    parameterMapper: "use_reservation_id",
    requiresConfirmation: false,
  },

  // ============================================================================
  // DELIVERY COMPENSATIONS
  // ============================================================================

  fulfill_intent: {
    toolName: "cancel_fulfillment",
    parameterMapper: "use_fulfillment_id",
    requiresConfirmation: false,
  },

  dispatch_intent: {
    toolName: "cancel_fulfillment",
    parameterMapper: "use_order_id",
    requiresConfirmation: false,
  },

  calculate_delivery_quote: {
    // No compensation needed - read-only
    toolName: "",
    parameterMapper: "identity",
    requiresConfirmation: false,
  },

  // ============================================================================
  // MOBILITY / RIDE COMPENSATIONS
  // ============================================================================

  request_ride: {
    toolName: "cancel_ride",
    parameterMapper: "use_ride_id",
    requiresConfirmation: false,
  },

  mobility_request: {
    toolName: "cancel_ride",
    parameterMapper: "use_ride_id",
    requiresConfirmation: false,
  },

  get_route_estimate: {
    // No compensation needed - read-only
    toolName: "",
    parameterMapper: "identity",
    requiresConfirmation: false,
  },

  // ============================================================================
  // WAITLIST COMPENSATIONS
  // ============================================================================

  add_to_waitlist: {
    toolName: "update_waitlist_status",
    parameterMapper: "use_reservation_id",
    requiresConfirmation: false,
    // Sets status to 'removed' using the waitlistId from original params
    customMapper: (originalParams: OriginalParams) => {
      return {
        waitlistId: originalParams.waitlistId,
        status: "removed",
      };
    },
  },

  // ============================================================================
  // CALENDAR COMPENSATIONS
  // ============================================================================

  add_calendar_event: {
    // Calendar events typically don't have a delete API in this system
    // Mark as non-compensable
    toolName: "",
    parameterMapper: "identity",
    requiresConfirmation: false,
  },

  // ============================================================================
  // COMMUNICATION COMPENSATIONS
  // ============================================================================

  send_communication: {
    // Communications are typically non-reversible (email/SMS already sent)
    // Mark as non-compensable but log for audit
    toolName: "",
    parameterMapper: "identity",
    requiresConfirmation: false,
  },
};

/**
 * Tools that are idempotent and don't need compensation
 */
export const IDEMPOTENT_TOOLS = new Set([
  "getAvailability",
  "get_table_availability",
  "get_reservation",
  "list_reservations",
  "check_table_conflicts",
  "validate_reservation",
  "validate_fulfillment",
  "get_fulfillment_status",
  "calculateQuote",
  "calculate_delivery_quote",
  "getDriverLocation",
  "get_weather_data",
  "geocode_location",
  "search_restaurant",
  "discover_restaurant",
  "get_local_vendors",
  "check_kitchen_load",
  "getLiveOperationalState",
]);

/**
 * Tools that require compensation (state-modifying operations)
 */
export const COMPENSATABLE_TOOLS = new Set(Object.keys(COMPENSATIONS));

/**
 * Check if a tool needs compensation
 */
export function needsCompensation(toolName: string): boolean {
  return COMPENSATABLE_TOOLS.has(toolName) && !IDEMPOTENT_TOOLS.has(toolName);
}

/**
 * Get the compensation definition for a tool
 */
export function getCompensation(
  toolName: string,
): CompensationDefinition | undefined {
  return COMPENSATIONS[toolName];
}

/**
 * Map parameters from original step to compensation
 *
 * CRITICAL: This function must handle all parameter mapper types defined in CompensationDefinition.
 * Each mapper extracts the necessary ID from either the original parameters or the step result.
 */
export function mapCompensationParameters(
  toolName: string,
  originalParams: OriginalParams,
  stepResult?: StepResult,
): Record<string, unknown> {
  const compensation = COMPENSATIONS[toolName];
  if (!compensation || !compensation.toolName) {
    return {};
  }

  // Use custom mapper if provided (for complex compensations)
  if (compensation.customMapper) {
    return compensation.customMapper(originalParams, stepResult);
  }

  switch (compensation.parameterMapper) {
    case "use_booking_id": {
      const bookingId = stepResult?.booking_id;
      return bookingId ? { reservationId: bookingId } : {};
    }

    case "use_reservation_id": {
      const reservationId = originalParams.reservationId;
      return reservationId ? { reservationId } : {};
    }

    case "use_order_id": {
      const orderId = originalParams.order_id;
      return orderId ? { orderId } : {};
    }

    case "use_fulfillment_id": {
      const fulfillmentId = stepResult?.fulfillmentId;
      return fulfillmentId ? { fulfillmentId } : {};
    }

    case "use_ride_id": {
      // Extract ride ID from step result (returned by request_ride / mobility_request)
      const rideId = stepResult?.ride_id || stepResult?.order_id;

      // If no ride_id in result, try to construct from original params
      if (!rideId) {
        const pickup = originalParams.pickup_location;
        const destination = originalParams.destination_location;
        const service = originalParams.service;

        // Return original params for manual cancellation
        return {
          service,
          pickup_location: pickup,
          destination_location: destination,
        };
      }

      return { ride_id: rideId };
    }

    case "identity":
    default:
      return originalParams as Record<string, unknown>;
  }
}

/**
 * Get the compensation tool name for a given tool
 */
export function getCompensationToolName(toolName: string): string | undefined {
  return COMPENSATIONS[toolName]?.toolName || undefined;
}
