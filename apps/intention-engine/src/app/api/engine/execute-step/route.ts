/**
 * Execute Step API - Recursive Self-Trigger Pattern
 * 
 * Vercel Hobby Tier Optimization for Infinite-Duration Sagas:
 * - Executes ONE step per lambda invocation
 * - Uses Redis locking to prevent double execution
 * - Triggers next step via non-blocking fetch with 200ms delay
 * - Publishes progress to Ably for real-time UX
 * 
 * Architecture:
 * 1. Receives executionId from previous step or initial trigger
 * 2. Acquires Redis lock (SETNX exec:{id}:lock)
 * 3. Loads execution state from Redis
 * 4. Finds next pending step (not in completedSteps array)
 * 5. Executes step using ToolRegistry
 * 6. Updates Redis state (adds to completedSteps)
 * 7. Publishes ExecutionStepUpdate to Ably
 * 8. If steps remain: spawns background fetch to self with 200ms delay
 * 9. Releases lock
 * 
 * Security:
 * - Requires x-internal-system-key header for recursive calls
 * - Bypasses normal auth checks for internal system calls only
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { redis } from "@/lib/redis-client";
import { getToolRegistry } from "@/lib/engine/tools/registry";
import { loadExecutionState, saveExecutionState } from "@/lib/engine/memory";
import { RealtimeService } from "@repo/shared";
import { signServiceToken } from "@repo/auth";
import {
  ExecutionState,
  StepExecutionState,
  PlanStep,
} from "@/lib/engine/types";
import {
  getStepState,
  updateStepState,
  getCompletedSteps,
  getPendingSteps,
} from "@/lib/engine/state-machine";
import {
  validateBeforeExecution,
  extractErrorCode,
  isClientOrServerError,
  attemptErrorRecovery,
} from "@/lib/engine/execution-helpers";
import { needsCompensation } from "@repo/mcp-protocol";
import { NormalizationService } from "@repo/shared";

export const runtime = "nodejs";
export const maxDuration = 10; // Vercel Hobby limit

// ============================================================================
// CONFIGURATION
// ============================================================================

const INTERNAL_SYSTEM_KEY = process.env.INTERNAL_SYSTEM_KEY || "internal-system-key-change-in-production";
const RECURSIVE_DELAY_MS = 200;
const STEP_TIMEOUT_MS = 8500; // Abort individual steps at 8.5s

// ============================================================================
// REQUEST/RESPONSE SCHEMAS
// ============================================================================

const ExecuteStepRequestSchema = z.object({
  executionId: z.string().uuid(),
  // Optional: for resuming from a specific step
  startStepIndex: z.number().int().nonnegative().optional(),
});

const ExecuteStepResponseSchema = z.object({
  success: z.boolean(),
  executionId: z.string(),
  stepExecuted: z.string().optional(),
  stepStatus: z.enum(["completed", "failed", "pending", "no_steps_remaining"]).optional(),
  completedSteps: z.number(),
  totalSteps: z.number(),
  isComplete: z.boolean(),
  nextStepTriggered: z.boolean().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
});

// ============================================================================
// REDIS LOCKING
// Prevents double execution when recursive fetch fires twice
// ============================================================================

async function acquireLock(executionId: string, ttlSeconds: number = 30): Promise<boolean> {
  const lockKey = `exec:${executionId}:lock`;
  
  // SETNX - Set if Not eXists
  const acquired = await redis.set(lockKey, "locked", {
    nx: true,
    ex: ttlSeconds,
  });
  
  return acquired === "OK";
}

async function releaseLock(executionId: string): Promise<void> {
  const lockKey = `exec:${executionId}:lock`;
  await redis.del(lockKey);
}

async function isLockHeld(executionId: string): Promise<boolean> {
  const lockKey = `exec:${executionId}:lock`;
  const exists = await redis.exists(lockKey);
  return exists === 1;
}

// ============================================================================
// STEP EXECUTION
// Single step execution with validation and error handling
// ============================================================================

interface StepExecutionResult {
  success: boolean;
  stepState: StepExecutionState;
  compensation?: {
    toolName: string;
    parameters?: Record<string, unknown>;
  };
}

async function executeSingleStep(
  executionId: string,
  state: ExecutionState,
  step: PlanStep
): Promise<StepExecutionResult> {
  const stepStartTime = performance.now();
  const timestamp = new Date().toISOString();
  const stepIndex = state.step_states.findIndex(s => s.step_id === step.id);
  const totalSteps = state.step_states.length;

  try {
    // IDEMPOTENCY CHECK - Never re-execute a step in completedSteps
    const completedStepIds = getCompletedSteps(state).map(s => s.step_id);
    if (completedStepIds.includes(step.id)) {
      console.log(`[ExecuteStep] Step ${step.id} already completed, skipping (idempotent)`);
      return {
        success: true,
        stepState: {
          step_id: step.id,
          status: "completed",
          output: { skipped: true, reason: "Already executed (idempotent)" },
          completed_at: timestamp,
          latency_ms: 0,
          attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
        },
      };
    }

    // Update step state to in_progress
    let newState = updateStepState(state, step.id, {
      status: "in_progress",
      started_at: timestamp,
      attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
    });

    // Resolve parameter references from previous step outputs
    const resolvedParameters = resolveStepParameters(step, newState);

    // Validation before execution using DB_REFLECTED_SCHEMAS
    const validationResult = await validateBeforeExecution(step, resolvedParameters);
    if (!validationResult.valid) {
      return {
        success: false,
        stepState: {
          step_id: step.id,
          status: "failed",
          error: {
            code: "VALIDATION_FAILED",
            message: validationResult.error || "Pre-execution validation failed",
          },
          completed_at: timestamp,
          latency_ms: 0,
          attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
        },
      };
    }

    // Save state with step in progress
    await saveExecutionState(newState);

    // Publish step start to Ably
    await RealtimeService.publishStreamingStatusUpdate({
      executionId,
      stepIndex: stepIndex >= 0 ? stepIndex : 0,
      totalSteps,
      stepName: step.tool_name,
      status: "in_progress",
      message: `Starting ${step.description || step.tool_name}...`,
      timestamp,
    });

    // Get tool registry and execute
    const registry = getToolRegistry();
    const toolDef = registry.getDefinition(step.tool_name);

    // ABORT CONTROLLER WITH TIMEOUT
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      console.warn(`[ExecuteStep] Step ${step.tool_name} approaching timeout, aborting...`);
      abortController.abort();
    }, STEP_TIMEOUT_MS);

    let toolResult: Awaited<ReturnType<typeof registry.execute>>;
    try {
      toolResult = await registry.execute(
        step.tool_name,
        resolvedParameters,
        {
          executionId,
          stepId: step.id,
          timeoutMs: step.timeout_ms || 30000,
          startTime: performance.now(),
          abortSignal: abortController.signal,
        }
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const stepEndTime = performance.now();
    const latencyMs = Math.round(stepEndTime - stepStartTime);

    if (toolResult.success) {
      // Publish step completion to Ably
      await RealtimeService.publishStreamingStatusUpdate({
        executionId,
        stepIndex: stepIndex >= 0 ? stepIndex : 0,
        totalSteps,
        stepName: step.tool_name,
        status: "completed",
        message: `Completed ${step.description || step.tool_name}`,
        timestamp: new Date().toISOString(),
      });

      // Auto-register compensation if needed
      let compensation: { toolName: string; parameters?: Record<string, unknown> } | undefined;
      if (needsCompensation(step.tool_name)) {
        const { getCompensation, mapCompensationParameters } = await import("@repo/mcp-protocol");
        const compDef = getCompensation(step.tool_name);
        if (compDef && compDef.toolName) {
          const mappedParams = mapCompensationParameters(
            step.tool_name,
            resolvedParameters,
            toolResult.output
          );
          compensation = {
            toolName: compDef.toolName,
            parameters: mappedParams,
          };
          console.log(
            `[ExecuteStep] Registered compensation for ${step.tool_name}: ${compDef.toolName}`
          );
        }
      }

      return {
        success: true,
        stepState: {
          step_id: step.id,
          status: "completed",
          output: toolResult.output,
          completed_at: new Date().toISOString(),
          latency_ms: latencyMs,
          attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
        },
        compensation,
      };
    } else {
      // Error recovery
      const errorCode = extractErrorCode(toolResult.error);
      if (isClientOrServerError(errorCode) && toolResult.error) {
        const recoveryResult = await attemptErrorRecovery(
          step,
          resolvedParameters,
          toolResult.error,
          errorCode
        );

        if (recoveryResult.recovered && recoveryResult.correctedParameters) {
          const retryResult = await registry.execute(
            step.tool_name,
            recoveryResult.correctedParameters,
            {
              executionId,
              stepId: step.id,
              timeoutMs: step.timeout_ms || 30000,
              startTime: performance.now(),
            }
          );

          if (retryResult.success) {
            await RealtimeService.publishStreamingStatusUpdate({
              executionId,
              stepIndex: stepIndex >= 0 ? stepIndex : 0,
              totalSteps,
              stepName: step.tool_name,
              status: "completed",
              message: `Completed ${step.description || step.tool_name} (after retry)`,
              timestamp: new Date().toISOString(),
            });

            return {
              success: true,
              stepState: {
                step_id: step.id,
                status: "completed",
                output: retryResult.output,
                completed_at: new Date().toISOString(),
                latency_ms: latencyMs,
                attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
              },
            };
          }
        }
      }

      // Step failed
      await RealtimeService.publishStreamingStatusUpdate({
        executionId,
        stepIndex: stepIndex >= 0 ? stepIndex : 0,
        totalSteps,
        stepName: step.tool_name,
        status: "failed",
        message: `Failed: ${typeof toolResult.error === "string" ? toolResult.error : "Unknown error"}`,
        timestamp: new Date().toISOString(),
      });

      const isValidationError = toolResult.error?.toLowerCase().includes("invalid parameters");
      return {
        success: false,
        stepState: {
          step_id: step.id,
          status: "failed",
          error: {
            code: isValidationError ? "TOOL_VALIDATION_FAILED" : "TOOL_EXECUTION_FAILED",
            message: toolResult.error || "Unknown tool execution error",
          },
          completed_at: new Date().toISOString(),
          latency_ms: latencyMs,
          attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
        },
      };
    }
  } catch (error) {
    const stepEndTime = performance.now();
    const latencyMs = Math.round(stepEndTime - stepStartTime);
    const errorMessage = error instanceof Error ? error.message : String(error);

    await RealtimeService.publishStreamingStatusUpdate({
      executionId,
      stepIndex: stepIndex >= 0 ? stepIndex : 0,
      totalSteps,
      stepName: step.tool_name,
      status: "failed",
      message: `Error: ${errorMessage}`,
      timestamp: new Date().toISOString(),
    });

    return {
      success: false,
      stepState: {
        step_id: step.id,
        status: "failed",
        error: {
          code: "STEP_EXECUTION_FAILED",
          message: errorMessage,
        },
        completed_at: new Date().toISOString(),
        latency_ms: latencyMs,
        attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
      },
    };
  }
}

// ============================================================================
// PARAMETER RESOLUTION
// Resolve $stepId.field references from previous step outputs
// ============================================================================

function resolveStepParameters(
  step: PlanStep,
  state: ExecutionState
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(step.parameters)) {
    if (
      typeof value === "string" &&
      value.startsWith("$") &&
      value.includes(".")
    ) {
      const ref = value.substring(1);
      const [stepId, ...fieldPath] = ref.split(".");

      const depState = getStepState(state, stepId);
      if (depState && depState.output) {
        let fieldValue: unknown = depState.output;
        for (const field of fieldPath) {
          if (
            fieldValue &&
            typeof fieldValue === "object" &&
            field in fieldValue
          ) {
            fieldValue = (fieldValue as Record<string, unknown>)[field];
          } else {
            fieldValue = undefined;
            break;
          }
        }
        resolved[key] = fieldValue ?? value;
      } else {
        resolved[key] = value;
      }
    } else {
      resolved[key] = value;
    }
  }

  return resolved;
}

// ============================================================================
// RECURSIVE TRIGGER
// Non-blocking fetch to self to trigger next step
// ============================================================================

async function triggerNextStep(executionId: string, currentStepIndex: number): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const url = `${appUrl}/api/engine/execute-step`;

  // Spawn background task with delay
  setTimeout(async () => {
    try {
      console.log(`[ExecuteStep] Triggering next step for ${executionId} (step ${currentStepIndex + 1})`);
      
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-system-key": INTERNAL_SYSTEM_KEY,
        },
        body: JSON.stringify({
          executionId,
          startStepIndex: currentStepIndex + 1,
        }),
        // Important: Don't wait for response
      });

      if (!response.ok) {
        console.error(
          `[ExecuteStep] Failed to trigger next step: ${response.status} ${response.statusText}`
        );
      } else {
        console.log(`[ExecuteStep] Next step triggered successfully`);
      }
    } catch (error) {
      console.error(`[ExecuteStep] Error triggering next step:`, error);
    }
  }, RECURSIVE_DELAY_MS);
}

// ============================================================================
// API HANDLER
// ============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  const startTime = performance.now();

  try {
    // Parse request
    const rawBody = await request.json();
    const validatedBody = ExecuteStepRequestSchema.safeParse(rawBody);

    if (!validatedBody.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: `Invalid request: ${validatedBody.error.message}`,
          },
        },
        { status: 400 }
      );
    }

    const { executionId, startStepIndex = 0 } = validatedBody.data;

    // SECURITY: Check internal system key for recursive calls
    // Allow first call without key (from /api/execute or /api/chat)
    const internalKey = request.headers.get("x-internal-system-key");
    const isRecursiveCall = internalKey !== null;
    
    if (isRecursiveCall && internalKey !== INTERNAL_SYSTEM_KEY) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "UNAUTHORIZED",
            message: "Invalid internal system key",
          },
        },
        { status: 401 }
      );
    }

    // ACQUIRE LOCK - Prevent double execution
    const lockAcquired = await acquireLock(executionId);
    if (!lockAcquired) {
      console.warn(`[ExecuteStep] Lock already held for ${executionId}, aborting`);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "LOCK_HELD",
            message: "Execution lock already held, skipping to prevent double execution",
          },
        },
        { status: 409 }
      );
    }

    try {
      // Load execution state from Redis
      const state = await loadExecutionState(executionId);
      if (!state) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "EXECUTION_NOT_FOUND",
              message: `Execution ${executionId} not found`,
            },
          },
          { status: 404 }
        );
      }

      // Get pending steps
      const pendingSteps = getPendingSteps(state);
      
      // Filter to steps starting from startStepIndex
      const plan = state.plan;
      if (!plan) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "PLAN_NOT_FOUND",
              message: "No plan found in execution state",
            },
          },
          { status: 404 }
        );
      }

      // Find next step to execute
      const completedStepIds = getCompletedSteps(state).map(s => s.step_id);
      const nextStep = plan.steps.find((step, index) => 
        index >= startStepIndex && !completedStepIds.includes(step.id)
      );

      if (!nextStep) {
        // No more steps - execution complete
        const completedCount = getCompletedSteps(state).length;
        
        // Check if any steps failed
        const hasFailedSteps = state.step_states.some(s => s.status === "failed");
        
        return NextResponse.json(
          ExecuteStepResponseSchema.parse({
            success: !hasFailedSteps,
            executionId,
            stepExecuted: undefined,
            stepStatus: "no_steps_remaining",
            completedSteps: completedCount,
            totalSteps: plan.steps.length,
            isComplete: true,
            nextStepTriggered: false,
          })
        );
      }

      const stepIndex = plan.steps.indexOf(nextStep);

      console.log(
        `[ExecuteStep] Executing step ${stepIndex + 1}/${plan.steps.length}: ${nextStep.tool_name} (${nextStep.id})`
      );

      // Execute the step
      const result = await executeSingleStep(executionId, state, nextStep);

      // Update state with step result
      const updatedState = updateStepState(state, nextStep.id, result.stepState);
      
      // Save updated state to Redis
      await saveExecutionState(updatedState);

      // Determine if we should trigger next step
      const willTriggerNext = result.success && (stepIndex < plan.steps.length - 1);

      // If step succeeded and more steps remain, trigger next step recursively
      if (willTriggerNext) {
        await triggerNextStep(executionId, stepIndex);
      }

      const completedCount = getCompletedSteps(updatedState).length;

      return NextResponse.json(
        ExecuteStepResponseSchema.parse({
          success: result.success,
          executionId,
          stepExecuted: nextStep.id,
          stepStatus: result.stepState.status,
          completedSteps: completedCount,
          totalSteps: plan.steps.length,
          isComplete: completedCount === plan.steps.length,
          nextStepTriggered: willTriggerNext,
        })
      );
    } finally {
      // RELEASE LOCK
      await releaseLock(executionId);
    }
  } catch (error) {
    console.error("[ExecuteStep] Unhandled error:", error);
    
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 500 }
    );
  }
}
