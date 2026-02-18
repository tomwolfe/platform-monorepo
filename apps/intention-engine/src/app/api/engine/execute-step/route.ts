/**
 * Execute Step API - Recursive Self-Trigger Pattern with WorkflowMachine
 *
 * Vercel Hobby Tier Optimization for Infinite-Duration Sagas:
 * - Executes ONE step per lambda invocation using WorkflowMachine
 * - Uses Redis locking to prevent double execution
 * - Triggers next step via QStash for reliable delivery
 * - Publishes progress to Ably for real-time UX
 * - Handles saga compensations automatically via WorkflowMachine
 *
 * Architecture:
 * 1. Receives executionId from previous step or initial trigger
 * 2. Acquires Redis lock (SETNX exec:{id}:lock)
 * 3. Loads execution state from Redis
 * 4. Creates WorkflowMachine with current state
 * 5. Executes single step via WorkflowMachine.executeSingleStep()
 * 6. WorkflowMachine handles validation, execution, and compensation
 * 7. Saves updated state to Redis
 * 8. Publishes ExecutionStepUpdate to Ably
 * 9. If steps remain: triggers QStash to invoke next step
 * 10. Releases lock
 *
 * Security:
 * - Requires x-internal-system-key header for recursive calls
 * - QStash webhook verification for production deployments
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { redis } from "@/lib/redis-client";
import { getToolRegistry } from "@/lib/engine/tools/registry";
import { loadExecutionState, saveExecutionState } from "@/lib/engine/memory";
import { RealtimeService } from "@repo/shared";
import {
  ExecutionState,
} from "@/lib/engine/types";
import {
  getCompletedSteps,
} from "@/lib/engine/state-machine";
import { QStashService, verifyQStashWebhook } from "@repo/shared";
import { NervousSystemObserver } from "@/lib/listeners/nervous-system-observer";
import { WorkflowMachine } from "@/lib/engine/workflow-machine";
import type { ToolExecutor as WorkflowToolExecutor } from "@/lib/engine/workflow-machine";

// ============================================================================
// TOOL EXECUTOR ADAPTER
// Adapts ToolRegistry to WorkflowMachine's ToolExecutor interface
// ============================================================================

function createToolExecutor(executionId: string): WorkflowToolExecutor {
  const registry = getToolRegistry();

  return {
    async execute(toolName, parameters, timeoutMs, signal) {
      const startTime = performance.now();

      try {
        const result = await registry.execute(toolName, parameters, {
          executionId,
          stepId: `step-${toolName}-${Date.now()}`,
          timeoutMs,
          startTime,
          abortSignal: signal,
        });

        return {
          success: result.success,
          output: result.output,
          error: result.error,
          latency_ms: Math.round(performance.now() - startTime),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          latency_ms: Math.round(performance.now() - startTime),
        };
      }
    },
  };
}

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
// RECURSIVE TRIGGER
// QStash-based queue trigger for reliable saga execution
// Replaces unreliable fetch(self) with guaranteed delivery
// ============================================================================

async function triggerNextStep(executionId: string, currentStepIndex: number): Promise<void> {
  // Use QStash for reliable queue-based execution
  const messageId = await QStashService.triggerNextStep({
    executionId,
    stepIndex: currentStepIndex + 1,
    internalKey: INTERNAL_SYSTEM_KEY,
  });

  if (messageId) {
    console.log(`[ExecuteStep] QStash message sent for next step [message: ${messageId}]`);
  } else {
    console.log(`[ExecuteStep] QStash not configured, using fallback fetch(self)`);
  }
}

// ============================================================================
// API HANDLER
// ============================================================================

/**
 * Execute Step Handler - Core business logic
 * Uses WorkflowMachine for unified saga execution with compensation support
 */
async function executeStepHandler(
  request: NextRequest,
  executionId: string,
  startStepIndex: number,
  startTime: number
): Promise<NextResponse> {
  try {
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

      // Validate plan exists
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

      // Check if all steps are already complete
      const completedStepIds = getCompletedSteps(state).map(s => s.step_id);
      const allStepsComplete = plan.steps.every(step => completedStepIds.includes(step.id));

      if (allStepsComplete) {
        const completedCount = getCompletedSteps(state).length;
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

      // Use WorkflowMachine for unified step execution with saga compensation
      const toolExecutor = createToolExecutor(executionId);
      const machine = new WorkflowMachine(executionId, toolExecutor, {
        initialState: state,
      });

      console.log(
        `[ExecuteStep] Using WorkflowMachine to execute step ${startStepIndex + 1}/${plan.steps.length}`
      );

      // Execute single step via WorkflowMachine (handles saga compensations)
      const result = await machine.executeSingleStep(startStepIndex);

      // Get updated state from machine
      const updatedState = machine.getState();

      // Save updated state to Redis
      await saveExecutionState(updatedState);

      // TRACK FAILED BOOKINGS - Store in Redis for proactive re-engagement
      if (!result.success && result.stepState.status === "failed") {
        const executedStep = plan.steps.find(step => step.id === result.stepId);
        if (executedStep && (executedStep.tool_name.includes("book") || executedStep.tool_name.includes("reserve"))) {
          const restaurantId = executedStep.parameters?.restaurantId as string | undefined;
          if (restaurantId) {
            const userId = (state.context?.userId as string) || undefined;
            const clerkId = (state.context?.clerkId as string) || undefined;
            const userEmail = (state.context?.userEmail as string) || undefined;

            await NervousSystemObserver.trackFailedBooking(restaurantId, {
              userId,
              clerkId,
              userEmail,
              intentType: state.intent?.type,
              parameters: executedStep.parameters,
              reason: result.stepState.error?.message || "Booking failed",
              executionId,
            });
          }
        }
      }

      // Determine if we should trigger next step
      const willTriggerNext = result.success && !result.isComplete;

      // If step succeeded and more steps remain, trigger next step recursively
      if (willTriggerNext) {
        const nextStepIndex = result.completedSteps;
        await triggerNextStep(executionId, nextStepIndex);
      }

      return NextResponse.json(
        ExecuteStepResponseSchema.parse({
          success: result.success,
          executionId,
          stepExecuted: result.stepId,
          stepStatus: result.stepState.status,
          completedSteps: result.completedSteps,
          totalSteps: result.totalSteps,
          isComplete: result.isComplete,
          nextStepTriggered: willTriggerNext,
        })
      );
    } finally {
      // RELEASE LOCK
      await releaseLock(executionId);
    }
  } catch (error) {
    console.error("[ExecuteStep] Handler error:", error);

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

export async function POST(request: NextRequest): Promise<NextResponse> {
  const startTime = performance.now();

  try {
    // QSTASH WEBHOOK VERIFICATION
    // In production, all requests should come from QStash and must be verified
    const headers = request.headers;
    const upstashSignature = headers.get("upstash-signature");
    const upstashKeyId = headers.get("upstash-key-id");

    // Check if this is a QStash webhook call
    const isQStashWebhook = upstashSignature !== null;

    // PRODUCTION SECURITY: Require webhook verification in production
    const isProduction = process.env.NODE_ENV === "production";
    const hasSigningKey = !!process.env.QSTASH_CURRENT_SIGNING_KEY;

    if (isQStashWebhook) {
      // Webhook signature present - verify it
      if (isProduction && !hasSigningKey) {
        console.warn(
          "[ExecuteStep] QStash webhook received but QSTASH_CURRENT_SIGNING_KEY not configured. " +
          "This is a security risk in production."
        );
        // In production without signing key, reject the request for security
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "WEBHOOK_NOT_CONFIGURED",
              message: "Webhook verification not configured. Set QSTASH_CURRENT_SIGNING_KEY.",
            },
          },
          { status: 500 }
        );
      }

      // In development without signing keys, skip verification
      if (!isProduction || !hasSigningKey) {
        console.warn("[ExecuteStep] QStash webhook verification skipped (dev mode or no key)");
        // Parse body normally
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
        return await executeStepHandler(request, executionId, startStepIndex, startTime);
      }

      // Production with signing key - verify signature
      const rawBody = await request.text();
      const isValid = await verifyQStashWebhook(rawBody, upstashSignature, upstashKeyId);

      if (!isValid) {
        console.warn("[ExecuteStep] QStash webhook signature verification failed");
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "UNAUTHORIZED",
              message: "Invalid QStash signature",
            },
          },
          { status: 401 }
        );
      }

      console.log("[ExecuteStep] QStash webhook verified, parsing body...");
      // Parse the body we already read
      const validatedBody = ExecuteStepRequestSchema.safeParse(JSON.parse(rawBody));

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
      return await executeStepHandler(request, executionId, startStepIndex, startTime);
    }

    // No webhook signature - direct API call
    // In production, this should only happen for initial trigger from /api/execute or /api/chat
    if (isProduction && hasSigningKey) {
      console.warn(
        "[ExecuteStep] Direct API call received in production with webhook configured. " +
        "Ensure this is intentional (e.g., initial trigger from trusted source)."
      );
    }

    // Non-QStash call (direct API call) - use normal flow
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
    return await executeStepHandler(request, executionId, startStepIndex, startTime);
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
