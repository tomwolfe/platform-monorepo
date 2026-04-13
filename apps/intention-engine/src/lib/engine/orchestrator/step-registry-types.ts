/**
 * Orchestration Step Registry Types
 *
 * Defines the types and interfaces for the step-based orchestration pattern.
 * This allows the orchestrator to focus purely on sequencing while
 * individual steps handle their own logic.
 *
 * @see Task 3: Decompose God Orchestrators
 */

import {
  Intent,
  Plan,
  ExecutionState,
  ExecutionTrace,
} from "@/lib/engine/types";

/**
 * Context passed between orchestration steps
 */
export interface OrchestrationContext {
  // Input
  input: string;
  executionId: string;
  userContext?: Record<string, unknown>;

  // Intermediate results (populated by steps)
  intent?: Intent;
  plan?: Plan;
  state?: ExecutionState;
  trace?: ExecutionTrace;

  // Options
  skipPlanning?: boolean;
  requireConfirmation?: boolean;

  // Metadata
  startTime: number;
  correlations?: Record<string, unknown>;
}

/**
 * Result of a step execution
 */
export interface StepResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Orchestration step interface
 *
 * Each step represents a discrete unit of work that can be:
 * - Unit tested in isolation
 * - Composed into different sequences
 * - Rolled back on failure
 */
export interface OrchestrationStep {
  /** Unique step name (for logging and tracing) */
  name: string;

  /**
   * Execute the step
   * @param context - Current orchestration context
   * @returns Updated context with step results
   */
  execute: (context: OrchestrationContext) => Promise<OrchestrationContext>;

  /**
   * Rollback the step (compensating transaction)
   * Called if a subsequent step fails
   * @param context - Current orchestration context
   */
  rollback?: (context: OrchestrationContext) => Promise<void>;

  /**
   * Check if this step should be executed
   * @param context - Current orchestration context
   * @returns true if step should run (default: true)
   */
  shouldExecute?: (context: OrchestrationContext) => boolean;
}

/**
 * Step result codes for status tracking
 */
export enum StepStatus {
  PENDING = "PENDING",
  EXECUTING = "EXECUTING",
  SUCCESS = "SUCCESS",
  FAILED = "FAILED",
  SKIPPED = "SKIPPED",
  ROLLED_BACK = "ROLLED_BACK",
}

/**
 * Execution record for tracking step execution order
 */
export interface ExecutionRecord {
  stepName: string;
  status: StepStatus;
  startedAt: number;
  completedAt?: number;
  error?: Error;
  metadata?: Record<string, unknown>;
}

/**
 * Orchestration result
 */
export interface OrchestrationResult {
  success: boolean;
  executionId: string;
  status: string;
  intent?: Intent;
  plan?: Plan;
  executionResult?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
  trace: ExecutionTrace;
  metadata: {
    duration_ms: number;
    total_tokens: number;
    step_count?: number;
    trace_id: string;
    total_ms: number;
    execution_log: ExecutionRecord[];
  };
}
