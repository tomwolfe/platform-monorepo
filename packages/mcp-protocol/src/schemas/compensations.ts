/**
 * Compensating Actions Registry - Phase 3: Saga Patterns
 * 
 * Defines the compensation (undo) action for each tool that modifies state.
 * Used by SagaManager to automatically roll back changes on failure.
 */

import { ToolInput } from "../index";

export interface CompensationDefinition {
  /** The tool name to execute for compensation */
  toolName: string;
  /** How to map parameters from the original step to the compensation */
  parameterMapper: "use_booking_id" | "use_order_id" | "use_reservation_id" | "use_fulfillment_id" | "identity";
  /** Whether the compensation requires confirmation (should be false for auto-compensation) */
  requiresConfirmation: boolean;
}

/**
 * Maps each tool to its compensating action.
 * Keys are tool names, values define how to undo the action.
 */
export const COMPENSATIONS: Record<string, CompensationDefinition> = {
  // ============================================================================
  // RESERVATION COMPENSATIONS
  // ============================================================================
  
  "create_reservation": {
    toolName: "cancel_reservation",
    parameterMapper: "use_reservation_id",
    requiresConfirmation: false,
  },
  
  "bookTable": {
    toolName: "cancel_reservation",
    parameterMapper: "use_booking_id",
    requiresConfirmation: false,
  },
  
  "book_tablestack_reservation": {
    toolName: "cancel_reservation",
    parameterMapper: "use_booking_id",
    requiresConfirmation: false,
  },
  
  "update_reservation": {
    toolName: "update_reservation",
    parameterMapper: "use_reservation_id",
    requiresConfirmation: false,
    // Note: This would need to restore previous values, not just cancel
  },
  
  "reserve_restaurant": {
    toolName: "cancel_reservation",
    parameterMapper: "use_reservation_id",
    requiresConfirmation: false,
  },

  // ============================================================================
  // DELIVERY COMPENSATIONS
  // ============================================================================
  
  "fulfill_intent": {
    toolName: "cancel_fulfillment",
    parameterMapper: "use_fulfillment_id",
    requiresConfirmation: false,
  },
  
  "dispatch_intent": {
    toolName: "cancel_fulfillment",
    parameterMapper: "use_order_id",
    requiresConfirmation: false,
  },
  
  "calculate_delivery_quote": {
    // No compensation needed - read-only
    toolName: "",
    parameterMapper: "identity",
    requiresConfirmation: false,
  },

  // ============================================================================
  // WAITLIST COMPENSATIONS
  // ============================================================================
  
  "add_to_waitlist": {
    toolName: "update_waitlist_status",
    parameterMapper: "use_reservation_id",
    requiresConfirmation: false,
    // Would need to set status to 'removed'
  },

  // ============================================================================
  // CALENDAR COMPENSATIONS
  // ============================================================================
  
  "add_calendar_event": {
    // Calendar events typically don't have a delete API in this system
    // Mark as non-compensable
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
export function getCompensation(toolName: string): CompensationDefinition | undefined {
  return COMPENSATIONS[toolName];
}

/**
 * Map parameters from original step to compensation
 */
export function mapCompensationParameters(
  toolName: string,
  originalParams: ToolInput,
  stepResult?: unknown
): Record<string, unknown> {
  const compensation = COMPENSATIONS[toolName];
  if (!compensation || !compensation.toolName) {
    return {};
  }

  switch (compensation.parameterMapper) {
    case "use_booking_id": {
      const bookingId = (stepResult as Record<string, unknown>)?.booking_id as string | undefined;
      return bookingId ? { reservationId: bookingId } : {};
    }
    
    case "use_reservation_id": {
      const reservationId = originalParams.reservationId as string | undefined;
      return reservationId ? { reservationId } : {};
    }
    
    case "use_order_id": {
      const orderId = originalParams.order_id as string | undefined;
      return orderId ? { orderId } : {};
    }
    
    case "use_fulfillment_id": {
      const fulfillmentId = (stepResult as Record<string, unknown>)?.fulfillmentId as string | undefined;
      return fulfillmentId ? { fulfillmentId } : {};
    }
    
    case "identity":
    default:
      return originalParams;
  }
}

/**
 * Get the compensation tool name for a given tool
 */
export function getCompensationToolName(toolName: string): string | undefined {
  return COMPENSATIONS[toolName]?.toolName || undefined;
}
