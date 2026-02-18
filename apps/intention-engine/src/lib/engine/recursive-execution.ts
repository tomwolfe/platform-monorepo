/**
 * Recursive Execution Helper
 * 
 * Utilities for triggering and managing infinite-duration sagas
 * using the recursive self-trigger pattern.
 * 
 * @module
 */

import { redis } from "../redis-client";
import { RealtimeService } from "@repo/shared";

// ============================================================================
// CONFIGURATION
// ============================================================================

const INTERNAL_SYSTEM_KEY = process.env.INTERNAL_SYSTEM_KEY || "internal-system-key-change-in-production";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

// ============================================================================
// TYPES
// ============================================================================

export interface ExecutionConfig {
  executionId: string;
  plan: {
    id: string;
    steps: Array<{
      id: string;
      tool_name: string;
      parameters: Record<string, unknown>;
      dependencies: string[];
      description: string;
    }>;
  };
  intentId?: string;
  traceId?: string;
  correlationId?: string;
}

export interface ExecutionStatus {
  executionId: string;
  status: "pending" | "running" | "completed" | "failed" | "timeout";
  currentStepIndex: number;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  lastUpdatedAt: string;
  error?: string;
}

// ============================================================================
// EXECUTION TRIGGER
// Start a new recursive execution chain
// ============================================================================

/**
 * Trigger a new execution chain
 * 
 * This is the entry point for starting an infinite-duration saga.
 * It saves the initial state to Redis and triggers the first step.
 * 
 * @param config - Execution configuration
 * @returns executionId for tracking
 */
export async function triggerExecution(config: ExecutionConfig): Promise<string> {
  const { executionId, plan, intentId, traceId, correlationId } = config;
  const timestamp = new Date().toISOString();

  // Build initial execution state
  const executionState = {
    execution_id: executionId,
    status: "EXECUTING" as const,
    intent_id: intentId,
    plan_id: plan.id,
    plan,
    step_states: plan.steps.map((step, index) => ({
      step_id: step.id,
      status: "pending" as const,
      step_number: index,
      created_at: timestamp,
      updated_at: timestamp,
    })),
    current_step_index: 0,
    context: {
      trace_id: traceId,
      correlation_id: correlationId,
    },
    created_at: timestamp,
    updated_at: timestamp,
  };

  // Save state to Redis with 1 hour TTL
  const stateKey = `intentionengine:execution_state:${executionId}`;
  await redis.setex(stateKey, 3600, JSON.stringify(executionState));

  console.log(`[RecursiveExecution] Saved initial state for ${executionId}`);

  // Trigger first step via non-blocking fetch
  // Don't await - let it run in background
  triggerStep(executionId, 0).catch((error) => {
    console.error(`[RecursiveExecution] Failed to trigger first step:`, error);
  });

  return executionId;
}

/**
 * Trigger a specific step execution
 * 
 * Calls the /api/engine/execute-step endpoint with a 200ms delay.
 * This creates the recursive chain of lambda invocations.
 * 
 * @param executionId - Execution ID
 * @param stepIndex - Step index to start from
 */
export async function triggerStep(
  executionId: string,
  stepIndex: number
): Promise<void> {
  const url = `${APP_URL}/api/engine/execute-step`;

  // Add delay to allow previous lambda to fully complete
  await new Promise((resolve) => setTimeout(resolve, 200));

  try {
    console.log(`[RecursiveExecution] Triggering step ${stepIndex} for ${executionId}`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-system-key": INTERNAL_SYSTEM_KEY,
      },
      body: JSON.stringify({
        executionId,
        startStepIndex: stepIndex,
      }),
      // Important: Don't wait for response in production
      // In development, you might want to await for debugging
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[RecursiveExecution] Step trigger failed: ${response.status} ${response.statusText}`,
        errorText
      );
    } else {
      console.log(`[RecursiveExecution] Step ${stepIndex} triggered successfully`);
    }
  } catch (error) {
    console.error(`[RecursiveExecution] Error triggering step:`, error);
  }
}

// ============================================================================
// EXECUTION STATUS
// Query execution state from Redis
// ============================================================================

/**
 * Get execution status
 * 
 * @param executionId - Execution ID
 * @returns Current execution status
 */
export async function getExecutionStatus(
  executionId: string
): Promise<ExecutionStatus | null> {
  const stateKey = `intentionengine:execution_state:${executionId}`;
  const stateJson = await redis.get<string>(stateKey);

  if (!stateJson) {
    return null;
  }

  const state = JSON.parse(stateJson);

  const completedSteps = state.step_states.filter(
    (s: any) => s.status === "completed"
  ).length;
  const failedSteps = state.step_states.filter(
    (s: any) => s.status === "failed"
  ).length;
  const currentStepIndex = state.step_states.findIndex(
    (s: any) => s.status === "in_progress"
  );

  return {
    executionId: state.execution_id,
    status: state.status.toLowerCase() as ExecutionStatus["status"],
    currentStepIndex: currentStepIndex >= 0 ? currentStepIndex : completedSteps,
    totalSteps: state.step_states.length,
    completedSteps,
    failedSteps,
    lastUpdatedAt: state.updated_at,
    error: state.error?.message,
  };
}

/**
 * Check if execution is complete
 * 
 * @param executionId - Execution ID
 * @returns True if all steps are completed or failed
 */
export async function isExecutionComplete(executionId: string): Promise<boolean> {
  const status = await getExecutionStatus(executionId);
  return status?.status === "completed" || status?.status === "failed";
}

/**
 * Wait for execution to complete (polling)
 * 
 * @param executionId - Execution ID
 * @param timeoutMs - Maximum time to wait (default: 60s)
 * @param pollIntervalMs - Polling interval (default: 500ms)
 * @returns Final execution status
 */
export async function waitForExecution(
  executionId: string,
  timeoutMs: number = 60000,
  pollIntervalMs: number = 500
): Promise<ExecutionStatus | null> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const status = await getExecutionStatus(executionId);

    if (!status) {
      throw new Error(`Execution ${executionId} not found`);
    }

    if (status.status === "completed" || status.status === "failed") {
      return status;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Execution ${executionId} timed out after ${timeoutMs}ms`);
}

// ============================================================================
// FAILED BOOKINGS TRACKING
// Helper functions for tracking and clearing failed bookings
// ============================================================================

/**
 * Track a failed booking in Redis
 * 
 * @param restaurantId - Restaurant ID where booking failed
 * @param failure - Failure details
 */
export async function trackFailedBooking(
  restaurantId: string,
  failure: {
    userId?: string;
    clerkId?: string;
    userEmail?: string;
    intentType?: string;
    parameters?: Record<string, unknown>;
    reason?: string;
    executionId?: string;
  }
): Promise<void> {
  const failedBookingsKey = `failed_bookings:${restaurantId}`;

  const failureRecord = {
    userId: failure.userId,
    clerkId: failure.clerkId,
    userEmail: failure.userEmail,
    intentType: failure.intentType,
    parameters: failure.parameters,
    reason: failure.reason || "Booking failed",
    executionId: failure.executionId,
    timestamp: new Date().toISOString(),
  };

  // Get existing failures
  const existingFailures = await redis.get<any[]>(failedBookingsKey) || [];

  // Add new failure (keep only last 10 to avoid bloat)
  const updatedFailures = [failureRecord, ...existingFailures].slice(0, 10);

  // Store with 1 hour TTL
  await redis.setex(failedBookingsKey, 3600, JSON.stringify(updatedFailures));

  console.log(
    `[RecursiveExecution] Tracked failed booking for restaurant ${restaurantId}`
  );
}

/**
 * Clear failed bookings for a restaurant
 * 
 * @param restaurantId - Restaurant ID
 * @param userId - Optional user ID to clear specific failure
 */
export async function clearFailedBookings(
  restaurantId: string,
  userId?: string
): Promise<void> {
  const failedBookingsKey = `failed_bookings:${restaurantId}`;

  if (!userId) {
    // Clear all failures
    await redis.del(failedBookingsKey);
    console.log(
      `[RecursiveExecution] Cleared all failed bookings for restaurant ${restaurantId}`
    );
  } else {
    // Remove specific user's failure
    const existingFailures = await redis.get<any[]>(failedBookingsKey) || [];
    const updatedFailures = existingFailures.filter(
      (f) => f.userId !== userId && f.clerkId !== userId
    );

    if (updatedFailures.length === 0) {
      await redis.del(failedBookingsKey);
    } else {
      await redis.setex(failedBookingsKey, 3600, JSON.stringify(updatedFailures));
    }

    console.log(
      `[RecursiveExecution] Cleared failed booking for user ${userId} at restaurant ${restaurantId}`
    );
  }
}

/**
 * Get failed bookings for a restaurant
 * 
 * @param restaurantId - Restaurant ID
 * @returns Array of failure records
 */
export async function getFailedBookings(
  restaurantId: string
): Promise<Array<{
  userId?: string;
  clerkId?: string;
  userEmail?: string;
  intentType?: string;
  parameters?: Record<string, unknown>;
  reason?: string;
  executionId?: string;
  timestamp: string;
}>> {
  const failedBookingsKey = `failed_bookings:${restaurantId}`;
  return await redis.get<any[]>(failedBookingsKey) || [];
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  triggerExecution,
  triggerStep,
  getExecutionStatus,
  isExecutionComplete,
  waitForExecution,
  trackFailedBooking,
  clearFailedBookings,
  getFailedBookings,
};
