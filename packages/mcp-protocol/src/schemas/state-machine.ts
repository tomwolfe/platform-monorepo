import { z } from "zod";

/**
 * State Machine & Safety Protocol Schemas
 * 
 * Vercel Hobby Tier Optimization:
 * - Task Queue state machine types for durable execution
 * - Safety guardrails for high-risk tool validation
 * - Confirmation workflow schemas
 */

// ============================================================================
// TASK STATE MACHINE
// ============================================================================

/**
 * Task status enum for state machine transitions
 */
export const TaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "awaiting_confirmation",
  "completed",
  "failed",
  "cancelled",
  "compensating",
  "compensated",
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * State transition record
 */
export const TaskStateTransitionSchema = z.object({
  from_status: TaskStatusSchema,
  to_status: TaskStatusSchema,
  timestamp: z.string().datetime(),
  reason: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type TaskStateTransition = z.infer<typeof TaskStateTransitionSchema>;

/**
 * Task state - represents the current state of an execution
 */
export const TaskStateSchema = z.object({
  task_id: z.string().uuid(),
  execution_id: z.string(),
  intent_id: z.string().uuid().optional(),
  status: TaskStatusSchema,
  current_step_index: z.number().int().nonnegative(),
  total_steps: z.number().int().positive(),
  segment_number: z.number().int().positive(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  transitions: z.array(TaskStateTransitionSchema).default([]),
  context: z.record(z.unknown()).default({}),
  error: z.object({
    code: z.string(),
    message: z.string(),
    step_id: z.string().optional(),
  }).optional(),
});

export type TaskState = z.infer<typeof TaskStateSchema>;

/**
 * Task queue item for scheduled execution
 */
export const TaskQueueItemSchema = z.object({
  task_id: z.string(),
  execution_id: z.string(),
  priority: z.number().int().nonnegative().default(0),
  scheduled_at: z.string().datetime(),
  max_attempts: z.number().int().positive().default(3),
  attempt_count: z.number().int().nonnegative().default(0),
  payload: z.object({
    intent_id: z.string().uuid().optional(),
    plan_id: z.string().uuid().optional(),
    start_step_index: z.number().int().nonnegative().optional(),
    segment_number: z.number().int().positive().optional(),
    trace_id: z.string().optional(),
  }),
});

export type TaskQueueItem = z.infer<typeof TaskQueueItemSchema>;

/**
 * State transition result
 */
export const StateTransitionResultSchema = z.object({
  success: z.boolean(),
  previous_state: TaskStateSchema.optional(),
  new_state: TaskStateSchema.optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
});

export type StateTransitionResult = z.infer<typeof StateTransitionResultSchema>;

// ============================================================================
// SAFETY GUARDRAILS
// ============================================================================

/**
 * High-risk tool categories
 */
export const HighRiskToolCategorySchema = z.enum([
  "delivery_fulfillment",
  "table_reservation",
  "financial_payment",
  "communication",
  "data_modification",
  "admin_action",
]);

export type HighRiskToolCategory = z.infer<typeof HighRiskToolCategorySchema>;

/**
 * High-risk tool definition
 */
export const HighRiskToolSchema = z.object({
  name: z.string(),
  category: HighRiskToolCategorySchema,
  requires_confirmation: z.boolean().default(true),
  max_risk_score: z.number().min(0).max(1).default(0.8),
});

export type HighRiskTool = z.infer<typeof HighRiskToolSchema>;

/**
 * Intent safety check result
 */
export const IntentSafetyCheckSchema = z.object({
  isSafe: z.boolean(),
  requiresConfirmation: z.boolean(),
  highRiskTools: z.array(z.string()),
  riskScore: z.number().min(0).max(1),
  reason: z.string().optional(),
  recommendedAction: z.enum(["proceed", "confirm", "block"]),
});

export type IntentSafetyCheck = z.infer<typeof IntentSafetyCheckSchema>;

/**
 * Plan step for safety validation
 */
export const SafetyPlanStepSchema = z.object({
  id: z.string().uuid(),
  tool_name: z.string(),
  parameters: z.record(z.unknown()).optional(),
  requires_confirmation: z.boolean().default(false),
});

export type SafetyPlanStep = z.infer<typeof SafetyPlanStepSchema>;

/**
 * Plan for safety validation
 */
export const SafetyPlanSchema = z.object({
  id: z.string().uuid(),
  steps: z.array(SafetyPlanStepSchema),
  summary: z.string().optional(),
});

export type SafetyPlan = z.infer<typeof SafetyPlanSchema>;

/**
 * Intent for safety validation
 */
export const SafetyIntentSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  confidence: z.number().min(0).max(1),
  parameters: z.record(z.unknown()).optional(),
  rawText: z.string(),
});

export type SafetyIntent = z.infer<typeof SafetyIntentSchema>;

// ============================================================================
// CONFIRMATION WORKFLOW
// ============================================================================

/**
 * Confirmation status
 */
export const ConfirmationStatusSchema = z.enum([
  "pending",
  "confirmed",
  "rejected",
  "expired",
]);

export type ConfirmationStatus = z.infer<typeof ConfirmationStatusSchema>;

/**
 * Confirmation request
 */
export const ConfirmationRequestSchema = z.object({
  execution_id: z.string(),
  step_id: z.string().uuid(),
  tool_name: z.string(),
  parameters: z.record(z.unknown()),
  riskScore: z.number().min(0).max(1),
  reason: z.string(),
  expires_at: z.string().datetime(),
});

export type ConfirmationRequest = z.infer<typeof ConfirmationRequestSchema>;

/**
 * Confirmation response
 */
export const ConfirmationResponseSchema = z.object({
  request: ConfirmationRequestSchema,
  status: ConfirmationStatusSchema,
  confirmed_at: z.string().datetime().optional(),
  confirmed_by: z.string().optional(),
  rejection_reason: z.string().optional(),
});

export type ConfirmationResponse = z.infer<typeof ConfirmationResponseSchema>;

// ============================================================================
// NERVOUS SYSTEM OBSERVER
// ============================================================================

/**
 * Table vacated event payload
 */
export const TableVacatedEventSchema = z.object({
  tableId: z.string(),
  restaurantId: z.string().uuid(),
  restaurantName: z.string().optional(),
  restaurantSlug: z.string().optional(),
  capacity: z.number().int().positive().optional(),
  timestamp: z.string().datetime(),
  traceId: z.string().optional(),
});

export type TableVacatedEvent = z.infer<typeof TableVacatedEventSchema>;

/**
 * User context match for proactive notifications
 */
export const UserContextMatchSchema = z.object({
  userId: z.string().uuid(),
  userEmail: z.string().email(),
  clerkId: z.string().optional(),
  lastInteractionContext: z.object({
    intentType: z.string().optional(),
    rawText: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
    timestamp: z.string().datetime().optional(),
    executionId: z.string().optional(),
    restaurantId: z.string().uuid().optional(),
    restaurantSlug: z.string().optional(),
    restaurantName: z.string().optional(),
  }),
  matchReason: z.string(),
  confidence: z.number().min(0).max(1),
});

export type UserContextMatch = z.infer<typeof UserContextMatchSchema>;

/**
 * Proactive notification
 */
export const ProactiveNotificationSchema = z.object({
  type: z.literal("proactive_table_availability"),
  title: z.string(),
  message: z.string(),
  data: z.object({
    tableId: z.string(),
    restaurantId: z.string().uuid(),
    restaurantName: z.string().optional(),
    capacity: z.number().int().positive().optional(),
    timestamp: z.string().datetime(),
    matchReason: z.string(),
    confidence: z.number().min(0).max(1),
    suggestedAction: z.string(),
  }),
  timestamp: z.string().datetime(),
});

export type ProactiveNotification = z.infer<typeof ProactiveNotificationSchema>;

// ============================================================================
// MCP DYNAMIC TOOL DISCOVERY
// ============================================================================

/**
 * Service registry entry for dynamic discovery
 */
export const ServiceRegistryEntrySchema = z.object({
  name: z.string(),
  mcpUrl: z.string().url(),
  apiUrl: z.string().url().optional(),
  healthUrl: z.string().url().optional(),
  capabilities: z.array(z.string()).optional(),
});

export type ServiceRegistryEntry = z.infer<typeof ServiceRegistryEntrySchema>;

/**
 * Tool call context for parameter aliasing
 */
export const ToolCallContextSchema = z.object({
  toolName: z.string(),
  parameters: z.record(z.unknown()),
  serverName: z.string(),
});

export type ToolCallContext = z.infer<typeof ToolCallContextSchema>;

/**
 * Tool call result
 */
export const ToolCallResultSchema = z.object({
  success: z.boolean(),
  output: z.record(z.unknown()).optional(),
  error: z.string().optional(),
});

export type ToolCallResult = z.infer<typeof ToolCallResultSchema>;

/**
 * Parameter alias mapping
 */
export const ParameterAliasSchema = z.record(z.string(), z.string());

export type ParameterAlias = z.infer<typeof ParameterAliasSchema>;

// ============================================================================
// STREAMING STATUS UPDATE
// ============================================================================

/**
 * Streaming status update for progress visualization
 */
export const StreamingStatusUpdateSchema = z.object({
  executionId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  totalSteps: z.number().int().positive(),
  stepName: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  message: z.string(),
  timestamp: z.string().datetime(),
  traceId: z.string().optional(),
});

export type StreamingStatusUpdate = z.infer<typeof StreamingStatusUpdateSchema>;

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Validate a state transition is allowed
 */
export const ValidStateTransitions: Record<TaskStatus, TaskStatus[]> = {
  pending: ["in_progress", "cancelled"],
  in_progress: ["completed", "failed", "awaiting_confirmation", "cancelled", "compensating"],
  awaiting_confirmation: ["in_progress", "cancelled", "failed"],
  completed: [],
  failed: ["compensating"],
  cancelled: [],
  compensating: ["compensated", "failed"],
  compensated: [],
};

/**
 * Check if a status is terminal
 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return ["completed", "failed", "cancelled", "compensated"].includes(status);
}

/**
 * Check if a transition is valid
 */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ValidStateTransitions[from].includes(to);
}
