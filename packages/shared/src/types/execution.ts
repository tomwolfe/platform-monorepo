/**
 * Shared Execution Types
 * Moved from apps/intention-engine/src/lib/engine/types.ts
 * Provides standardized execution state and trace types for all services.
 */

import { z } from "zod";

// ============================================================================
// EXECUTION STATUS ENUM
// Finite, explicit states for the execution lifecycle
// ============================================================================

export const ExecutionStatusSchema = z.enum([
  "RECEIVED",      // Initial state: execution request received
  "PARSING",       // Parsing user input into structured intent
  "PARSED",        // Intent successfully parsed and validated
  "PLANNING",      // Generating execution plan
  "PLANNED",       // Plan generated and validated
  "EXECUTING",     // Actively executing plan steps
  "AWAITING_CONFIRMATION", // Paused for user approval of a step
  "SUSPENDED",     // Human-in-the-Loop wait state: yielded for external confirmation
  "REFLECTING",    // Analyzing failure and replanning
  "COMPLETED",     // All steps executed successfully
  "FAILED",        // Execution failed (non-recoverable)
  "REJECTED",      // Plan or intent rejected by validation
  "TIMEOUT",       // Execution exceeded time limits
  "CANCELLED",     // Explicitly cancelled by user or system
]);

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

// ============================================================================
// STEP EXECUTION STATE
// Individual step tracking within an execution
// ============================================================================

export const StepExecutionStateSchema = z.object({
  step_id: z.string().uuid(),
  status: z.enum(["pending", "in_progress", "completed", "failed", "skipped", "timeout", "awaiting_confirmation", "suspended"]),
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }).optional(),
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  attempts: z.number().int().nonnegative().default(0),
  latency_ms: z.number().int().nonnegative().optional(),
});

export type StepExecutionState = z.infer<typeof StepExecutionStateSchema>;

// ============================================================================
// EXECUTION STATE SCHEMA
// Stateful tracking of execution progress
// ============================================================================

export const ExecutionStateSchema = z.object({
  execution_id: z.string().uuid(),
  status: ExecutionStatusSchema,
  intent: z.record(z.string(), z.unknown()).optional(), // Simplified Intent type
  plan: z.record(z.string(), z.unknown()).optional(),   // Simplified Plan type
  step_states: z.array(StepExecutionStateSchema).default([]),
  current_step_index: z.number().int().nonnegative().default(0),
  context: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    step_id: z.string().uuid().optional(),
    details: z.unknown().optional(),
  }).optional(),
  token_usage: z.object({
    prompt_tokens: z.number().int().nonnegative().default(0),
    completion_tokens: z.number().int().nonnegative().default(0),
    total_tokens: z.number().int().nonnegative().default(0),
  }).default({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  }),
  latency_ms: z.number().int().nonnegative().default(0),
});

export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

// ============================================================================
// TRACE ENTRY SCHEMA
// Observability and audit trail entry
// ============================================================================

export const TraceEntrySchema = z.object({
  timestamp: z.string().datetime(),
  phase: z.enum(["intent", "planning", "execution", "system"]),
  step_id: z.string().uuid().optional(),
  event: z.string(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
  latency_ms: z.number().int().nonnegative().optional(),
  model_id: z.string().optional(),
  token_usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }).optional(),
});

export type TraceEntry = z.infer<typeof TraceEntrySchema>;

// ============================================================================
// EXECUTION TRACE SCHEMA
// Complete audit trail for an execution
// ============================================================================

export const ExecutionTraceSchema = z.object({
  trace_id: z.string().uuid(),
  execution_id: z.string().uuid(),
  entries: z.array(TraceEntrySchema),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().optional(),
  total_latency_ms: z.number().int().nonnegative().optional(),
  total_token_usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    total_tokens: z.number().int().nonnegative(),
  }).optional(),
});

export type ExecutionTrace = z.infer<typeof ExecutionTraceSchema>;

// ============================================================================
// STATE TRANSITION VALIDATION
// Explicitly defines valid state transitions
// ============================================================================

export const ValidStateTransitions: Record<ExecutionStatus, ExecutionStatus[]> = {
  RECEIVED: ["PARSING", "CANCELLED"],
  PARSING: ["PARSED", "REJECTED", "TIMEOUT", "FAILED"],
  PARSED: ["PLANNING", "CANCELLED"],
  PLANNING: ["PLANNED", "REJECTED", "TIMEOUT", "FAILED"],
  PLANNED: ["EXECUTING", "CANCELLED"],
  EXECUTING: ["COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "REFLECTING", "AWAITING_CONFIRMATION", "SUSPENDED"],
  AWAITING_CONFIRMATION: ["EXECUTING", "CANCELLED", "FAILED"],
  SUSPENDED: ["EXECUTING", "CANCELLED", "FAILED"], // Can resume to EXECUTING or be cancelled
  REFLECTING: ["EXECUTING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  REJECTED: [],
  TIMEOUT: [],
  CANCELLED: [],
};

// ============================================================================
// TYPE GUARDS
// ============================================================================

export function isValidExecutionStatus(status: string): status is ExecutionStatus {
  return ExecutionStatusSchema.safeParse(status).success;
}

export function isValidStateTransition(
  from: ExecutionStatus,
  to: ExecutionStatus
): boolean {
  return ValidStateTransitions[from].includes(to);
}

export function isTerminalStatus(status: ExecutionStatus): boolean {
  return ["COMPLETED", "FAILED", "REJECTED", "TIMEOUT", "CANCELLED"].includes(status);
}
