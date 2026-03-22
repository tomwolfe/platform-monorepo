/**
 * Golden Path - Canonical Cross-App Execution Flow
 * 
 * This module defines the SINGLE canonical flow that all 3 apps must support:
 * 
 *   User Intent → Intention Engine → TableStack (reserve) → OpenDelivery (fallback/add-on) → Complete
 * 
 * Purpose:
 * - Provide a typed contract for end-to-end execution
 * - Enable deterministic testing of the full system
 * - Serve as the "happy path" reference implementation
 * - Define success/failure states across app boundaries
 * 
 * @see https://github.com/yourrepo/apps/blob/main/docs/golden-path.md
 */

import { z } from "zod";

// ============================================================================
// GOLDEN PATH INPUT CONTRACT
// The minimal viable user intent that triggers the full cross-app flow
// ============================================================================

export const GoldenPathIntentSchema = z.object({
  // Core intent fields
  id: z.string().uuid(),
  rawText: z.string(),
  
  // Intent type - must be one of these for golden path
  type: z.enum(["BOOKING", "DELIVERY", "UNIFIED_DINING"]),
  
  // Required parameters for the golden path
  parameters: z.object({
    // Restaurant booking parameters
    restaurant_id: z.string().optional(),
    restaurant_name: z.string().optional(),
    party_size: z.number().int().positive().optional(),
    date: z.string().optional(), // ISO 8601 date
    time: z.string().optional(), // HH:MM format
    
    // Delivery parameters (for unified dining or fallback)
    delivery_address: z.string().optional(),
    delivery_items: z.array(z.object({
      item_name: z.string(),
      quantity: z.number().int().positive(),
      special_instructions: z.string().optional(),
    })).optional(),
    
    // User context
    user_id: z.string().uuid(),
    location: z.object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    }).optional(),
  }),
  
  // Metadata
  metadata: z.object({
    source: z.string().default("user_input"),
    timestamp: z.string().datetime(),
    correlation_id: z.string().uuid().optional(),
  }),
});

export type GoldenPathIntent = z.infer<typeof GoldenPathIntentSchema>;

// ============================================================================
// GOLDEN PATH STEP CONTRACT
// Each step in the canonical flow with explicit app ownership
// ============================================================================

export type GoldenPathStepId = 
  | "parse_intent"
  | "generate_plan"
  | "validate_plan"
  | "execute_booking"
  | "execute_delivery"
  | "coordinate_unified"
  | "persist_state"
  | "notify_user";

export const GoldenPathStepSchema = z.object({
  // Step identification
  id: z.string().uuid(),
  step_id: z.enum([
    "parse_intent",
    "generate_plan", 
    "validate_plan",
    "execute_booking",
    "execute_delivery",
    "coordinate_unified",
    "persist_state",
    "notify_user",
  ]),
  
  // App ownership - which app owns this step
  owning_app: z.enum(["intention-engine", "table-stack", "open-delivery", "shared"]),
  
  // Step status
  status: z.enum([
    "pending",
    "in_progress", 
    "completed",
    "failed",
    "skipped", // Step was not needed for this flow variant
  ]),
  
  // Input/output for observability
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.record(z.string(), z.unknown()).optional(),
  
  // Error tracking
  error: z.object({
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean().default(false),
  }).optional(),
  
  // Performance metrics
  latency_ms: z.number().int().nonnegative().optional(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
});

export type GoldenPathStep = z.infer<typeof GoldenPathStepSchema>;

// ============================================================================
// GOLDEN PATH FLOW VARIANT
// Defines which variant of the golden path is being executed
// ============================================================================

export const GoldenPathVariantSchema = z.enum([
  // Full happy path: booking succeeds, no delivery needed
  "BOOKING_ONLY",
  
  // Booking fails, fallback to delivery
  "BOOKING_FALLBACK_TO_DELIVERY",
  
  // Unified: booking + delivery coordinated together
  "UNIFIED_DINING_WITH_DELIVERY",
  
  // Delivery only (no booking attempted)
  "DELIVERY_ONLY",
]);

export type GoldenPathVariant = z.infer<typeof GoldenPathVariantSchema>;

// ============================================================================
// GOLDEN PATH EXECUTION STATE
// Complete state machine for the canonical flow
// ============================================================================

export const GoldenPathStateSchema = z.object({
  // Execution identifiers
  execution_id: z.string().uuid(),
  intent_id: z.string().uuid(),
  variant: GoldenPathVariantSchema,
  
  // Overall status
  status: z.enum([
    "not_started",
    "in_progress",
    "completed_successfully",
    "completed_with_degradation", // e.g., booking failed but delivery succeeded
    "failed",
    "cancelled",
  ]),
  
  // Step execution tracking
  steps: z.array(GoldenPathStepSchema),
  
  // Cross-app state synchronization
  booking_state: z.object({
    reservation_id: z.string().uuid().optional(),
    restaurant_id: z.string().optional(),
    status: z.enum(["not_attempted", "pending", "confirmed", "failed", "cancelled"]).default("not_attempted"),
    failure_reason: z.string().optional(),
  }).optional(),
  
  delivery_state: z.object({
    delivery_id: z.string().uuid().optional(),
    quote_id: z.string().optional(),
    status: z.enum(["not_attempted", "quoted", "dispatched", "delivered", "failed", "cancelled"]).default("not_attempted"),
    failure_reason: z.string().optional(),
  }).optional(),
  
  // Unified coordination state (for UNIFIED_DINING_WITH_DELIVERY variant)
  coordination_state: z.object({
    delivery_timed_to_reservation: z.boolean().default(false),
    reservation_time: z.string().optional(),
    delivery_eta: z.string().optional(),
    special_instructions: z.string().optional(),
  }).optional(),
  
  // Performance metrics
  metrics: z.object({
    total_latency_ms: z.number().int().nonnegative().default(0),
    steps_completed: z.number().int().nonnegative().default(0),
    steps_failed: z.number().int().nonnegative().default(0),
    steps_skipped: z.number().int().nonnegative().default(0),
  }).default({
    total_latency_ms: 0,
    steps_completed: 0,
    steps_failed: 0,
    steps_skipped: 0,
  }),
  
  // Timestamps
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
});

export type GoldenPathState = z.infer<typeof GoldenPathStateSchema>;

// ============================================================================
// GOLDEN PATH RESULT
// Final outcome of executing the canonical flow
// ============================================================================

export const GoldenPathResultSchema = z.object({
  // Execution reference
  execution_id: z.string().uuid(),
  intent_id: z.string().uuid(),
  variant: GoldenPathVariantSchema,
  
  // Success indicator
  success: z.boolean(),
  
  // Outcome summary
  summary: z.string(),
  
  // What was actually accomplished
  outcomes: z.object({
    booking_attempted: z.boolean().default(false),
    booking_succeeded: z.boolean().default(false),
    delivery_attempted: z.boolean().default(false),
    delivery_succeeded: z.boolean().default(false),
    unified_coordination: z.boolean().default(false),
  }),
  
  // User-facing result
  user_message: z.string(),
  
  // Technical details for observability
  details: z.object({
    reservation_id: z.string().optional(),
    delivery_id: z.string().optional(),
    total_cost_usd: z.number().nonnegative().optional(),
    steps_executed: z.array(z.string()),
  }).optional(),
  
  // Error information if failed
  error: z.object({
    code: z.string(),
    message: z.string(),
    failed_step: z.string().optional(),
    recovery_suggestion: z.string().optional(),
  }).optional(),
  
  // Performance metrics
  metrics: z.object({
    total_latency_ms: z.number().int().nonnegative(),
    llm_calls: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
    cross_app_calls: z.number().int().nonnegative(),
  }),
  
  // Timestamp
  completed_at: z.string().datetime(),
});

export type GoldenPathResult = z.infer<typeof GoldenPathResultSchema>;

// ============================================================================
// GOLDEN PATH EXECUTOR INTERFACE
// The contract that any implementation must satisfy
// ============================================================================

export interface GoldenPathExecutor {
  /**
   * Execute the canonical flow for a given intent
   * 
   * @param intent - The user intent to execute
   * @returns Promise resolving to the execution result
   * 
   * @throws {GoldenPathError} If execution fails
   */
  execute(intent: GoldenPathIntent): Promise<GoldenPathResult>;
  
  /**
   * Get the current state of an execution
   * 
   * @param execution_id - The execution to query
   * @returns Promise resolving to the current state
   */
  getState(execution_id: string): Promise<GoldenPathState>;
  
  /**
   * Cancel an in-progress execution
   * 
   * @param execution_id - The execution to cancel
   * @param reason - Reason for cancellation
   * @returns Promise resolving to the cancelled state
   */
  cancel(execution_id: string, reason: string): Promise<GoldenPathState>;
}

// ============================================================================
// GOLDEN PATH ERROR
// Structured error type for golden path failures
// ============================================================================

export class GoldenPathError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly recoverable: boolean = false,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "GoldenPathError";
  }
}

// ============================================================================
// GOLDEN PATH CONSTANTS
// Configuration values for the canonical flow
// ============================================================================

export const GOLDEN_PATH_DEFAULTS = {
  // Timeout for the entire golden path execution
  TOTAL_TIMEOUT_MS: 120_000, // 2 minutes
  
  // Timeout for individual steps
  STEP_TIMEOUT_MS: 30_000, // 30 seconds
  
  // Maximum retries for recoverable failures
  MAX_RETRIES: 2,
  
  // Confidence threshold for plan execution
  CONFIDENCE_THRESHOLD: 0.7,
  
  // Apps involved in the golden path
  APPS: ["intention-engine", "table-stack", "open-delivery"] as const,
} as const;

// ============================================================================
// HELPER FUNCTIONS
// Utilities for working with the golden path
// ============================================================================

/**
 * Create a new golden path state from an intent
 */
export function createGoldenPathState(
  intent: GoldenPathIntent,
  variant: GoldenPathVariant
): GoldenPathState {
  const now = new Date().toISOString();
  
  return {
    execution_id: crypto.randomUUID(),
    intent_id: intent.id,
    variant,
    status: "in_progress",
    steps: [],
    booking_state: { status: "not_attempted" },
    delivery_state: { status: "not_attempted" },
    metrics: {
      total_latency_ms: 0,
      steps_completed: 0,
      steps_failed: 0,
      steps_skipped: 0,
    },
    started_at: now,
  };
}

/**
 * Determine the golden path variant from an intent
 */
export function determineGoldenPathVariant(intent: GoldenPathIntent): GoldenPathVariant {
  const params = intent.parameters;
  
  // Check for unified dining intent
  const hasBookingParams = !!(params.restaurant_id || params.restaurant_name || params.party_size);
  const hasDeliveryParams = !!(params.delivery_address || params.delivery_items?.length);
  
  if (hasBookingParams && hasDeliveryParams) {
    return "UNIFIED_DINING_WITH_DELIVERY";
  }
  
  if (hasBookingParams) {
    return "BOOKING_ONLY";
  }
  
  if (hasDeliveryParams) {
    return "DELIVERY_ONLY";
  }
  
  // Default to booking only if unclear
  return "BOOKING_ONLY";
}

/**
 * Validate that an intent is suitable for the golden path
 */
export function validateGoldenPathIntent(intent: unknown): { valid: boolean; error?: string } {
  const result = GoldenPathIntentSchema.safeParse(intent);
  
  if (!result.success) {
    return {
      valid: false,
      error: `Invalid golden path intent: ${result.error.message}`,
    };
  }
  
  // Additional business logic validation
  const params = result.data.parameters;
  
  // Must have either booking or delivery parameters
  if (
    !params.restaurant_id && 
    !params.restaurant_name && 
    !params.delivery_address && 
    !params.delivery_items?.length
  ) {
    return {
      valid: false,
      error: "Intent must specify either restaurant booking or delivery parameters",
    };
  }
  
  return { valid: true };
}
