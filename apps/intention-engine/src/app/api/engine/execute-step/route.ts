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
import { FailoverPolicyEngine, type PolicyEvaluationContext } from "@repo/shared";

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
export const maxDuration = 8; // Vercel Hobby limit - 8s buffer before 10s hard limit

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Map error messages to standardized failure reasons for policy evaluation
 */
function mapFailureReason(errorMessage?: string): PolicyEvaluationContext["failure_reason"] {
  if (!errorMessage) return "SERVICE_ERROR";

  const errorLower = errorMessage.toLowerCase();

  if (errorLower.includes("full") || errorLower.includes("no tables") || errorLower.includes("unavailable")) {
    return "RESTAURANT_FULL";
  }
  if (errorLower.includes("party size") || errorLower.includes("too large")) {
    return "PARTY_SIZE_TOO_LARGE";
  }
  if (errorLower.includes("payment") || errorLower.includes("card")) {
    return "PAYMENT_FAILED";
  }
  if (errorLower.includes("timeout") || errorLower.includes("timed out")) {
    return "TIMEOUT";
  }
  if (errorLower.includes("validation") || errorLower.includes("invalid")) {
    return "VALIDATION_FAILED";
  }
  if (errorLower.includes("delivery")) {
    return "DELIVERY_UNAVAILABLE";
  }

  return "SERVICE_ERROR";
}

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

/**
 * Acquire execution lock using SETNX
 * @param executionId - Execution ID to lock
 * @param ttlSeconds - Lock TTL (default 30s)
 * @returns true if lock acquired, false if already held
 */
async function acquireLock(executionId: string, ttlSeconds: number = 30): Promise<boolean> {
  const lockKey = `exec:${executionId}:lock`;

  // SETNX - Set if Not eXists
  const acquired = await redis.set(lockKey, "locked", {
    nx: true,
    ex: ttlSeconds,
  });

  return acquired === "OK";
}

/**
 * Release execution lock
 */
async function releaseLock(executionId: string): Promise<void> {
  const lockKey = `exec:${executionId}:lock`;
  await redis.del(lockKey);
}

/**
 * Check if lock is currently held
 */
async function isLockHeld(executionId: string): Promise<boolean> {
  const lockKey = `exec:${executionId}:lock`;
  const exists = await redis.exists(lockKey);
  return exists === 1;
}

/**
 * IDEMPOTENCY CHECK - Step-level locking
 * Prevents double execution of the same step when QStash retries
 * @param executionId - Execution ID
 * @param stepIndex - Step index
 * @param ttlSeconds - Lock TTL (default 1 hour)
 * @returns true if this is the first execution, false if duplicate
 */
async function acquireStepIdempotencyLock(
  executionId: string,
  stepIndex: number,
  ttlSeconds: number = 3600
): Promise<boolean> {
  const idempotencyKey = `exec:${executionId}:step:${stepIndex}:lock`;

  // SETNX - Set if Not eXists
  const acquired = await redis.set(idempotencyKey, "locked", {
    nx: true,
    ex: ttlSeconds,
  });

  return acquired === "OK";
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
      console.warn(`[ExecuteStep] Invalid internal key for ${executionId}`);
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

    // IDEMPOTENCY CHECK - Prevent double execution of same step
    // This is critical for QStash retries
    const stepIdempotencyLock = await acquireStepIdempotencyLock(executionId, startStepIndex);
    if (!stepIdempotencyLock) {
      console.warn(`[ExecuteStep] Step ${startStepIndex} already executed for ${executionId}, skipping (idempotent)`);
      
      // Load state to check if step was completed
      const state = await loadExecutionState(executionId);
      if (state) {
        const completedCount = getCompletedSteps(state).length;
        const plan = state.plan;
        const isComplete = plan ? completedCount === plan.steps.length : false;
        
        return NextResponse.json(
          ExecuteStepResponseSchema.parse({
            success: true,
            executionId,
            stepExecuted: undefined,
            stepStatus: "completed",
            completedSteps: completedCount,
            totalSteps: plan?.steps.length || 0,
            isComplete,
            nextStepTriggered: false,
          })
        );
      }
      
      return NextResponse.json(
        {
          success: true,
          error: {
            code: "ALREADY_EXECUTED",
            message: "Step already executed (idempotent skip)",
          },
        },
        { status: 200 }
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

      // ========================================================================
      // FAILOVER POLICY ENGINE - Autonomous Failover Handling
      // ========================================================================
      // When a step fails, evaluate against failover policies and potentially
      // trigger automatic replanning with alternative suggestions.
      // ========================================================================
      
      if (!result.success && result.stepState.status === "failed") {
        const executedStep = plan.steps.find(step => step.id === result.stepId);
        
        // Track failed bookings for proactive re-engagement (Step B)
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

        // STEP A: Evaluate failover policy and trigger automatic replan
        const failoverContext: PolicyEvaluationContext = {
          intent_type: (state.intent?.type as any) || "BOOKING",
          failure_reason: mapFailureReason(result.stepState.error?.message),
          confidence: state.intent?.confidence || 0.8,
          attempt_count: state.step_states.filter(s => s.status === "failed").length,
          party_size: (executedStep?.parameters?.partySize as number) || undefined,
          requested_time: (executedStep?.parameters?.time as string) || undefined,
          metadata: {
            executionId,
            stepId: result.stepId,
            restaurantId: (executedStep?.parameters?.restaurantId as string) || undefined,
          },
        };

        const failoverEngine = new FailoverPolicyEngine();
        const failoverResult = failoverEngine.evaluate(failoverContext);

        if (failoverResult.matched && failoverResult.recommended_action) {
          console.log(
            `[FailoverPolicyEngine] Matched policy "${failoverResult.policy?.name}" for failed step ${result.stepId}`
          );

          // Store failover state in Redis for the next planning iteration
          const failoverKey = `exec:${executionId}:failover`;
          await redis.setex(
            failoverKey,
            3600, // 1 hour TTL
            JSON.stringify({
              matched: true,
              policyId: failoverResult.policy?.id,
              policyName: failoverResult.policy?.name,
              recommendedAction: failoverResult.recommended_action,
              suggestions: failoverEngine.getAlternativeSuggestions(failoverContext, failoverResult),
              evaluatedAt: new Date().toISOString(),
            })
          );

          // Publish failover event to Ably for real-time UI updates
          try {
            await RealtimeService.publish(
              "nervous-system:updates",
              "FailoverPolicyTriggered",
              {
                executionId,
                policyName: failoverResult.policy?.name,
                actionType: failoverResult.recommended_action.type,
                message: failoverResult.recommended_action.message_template,
                timestamp: new Date().toISOString(),
              },
              {}
            );
          } catch (err) {
            console.warn("[FailoverPolicyEngine] Failed to publish to Ably:", err);
          }
        }

        // ========================================================================
        // AUTOMATIC REPLANNING TRIGGER
        // If failover policy recommends a specific action type, trigger replanning
        // with the new constraints/suggestions
        // ========================================================================
        const shouldReplan = [
          "SUGGEST_ALTERNATIVE_TIME",
          "SUGGEST_ALTERNATIVE_RESTAURANT",
          "SUGGEST_ALTERNATIVE_DATE",
          "TRIGGER_DELIVERY",
          "TRIGGER_WAITLIST",
          "ESCALATE_TO_HUMAN",
        ].includes(failoverResult.recommended_action.type);

        if (shouldReplan && redis) {
          try {
            // Mark execution for replanning
            const replanKey = `exec:${executionId}:replan`;
            await redis.setex(
              replanKey,
              300, // 5 minute TTL
              JSON.stringify({
                shouldReplan: true,
                reason: failoverResult.policy?.name || "Failover policy triggered",
                suggestedAction: failoverResult.recommended_action,
                suggestions: failoverEngine.getAlternativeSuggestions(failoverContext, failoverResult),
                originalIntent: state.intent,
                triggeredAt: new Date().toISOString(),
              })
            );

            console.log(
              `[ExecuteStep] Marked execution ${executionId} for automatic replanning: ${failoverResult.recommended_action.type}`
            );

            // Publish replan event to Ably for UI notification
            await RealtimeService.publish(
              "nervous-system:updates",
              "AutomaticReplanTriggered",
              {
                executionId,
                reason: failoverResult.policy?.name,
                actionType: failoverResult.recommended_action.type,
                message: `Your request needs adjustment. ${failoverResult.recommended_action.message_template}`,
                timestamp: new Date().toISOString(),
              },
              {}
            );
          } catch (replanError) {
            console.warn("[ExecuteStep] Failed to mark for replanning:", replanError);
            // Continue without replanning - not critical
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

      // ========================================================================
      // CHECK FOR REPLANNING MARKER
      // If execution is complete or failed and marked for replanning, trigger
      // a new planning cycle with the failover suggestions
      // ========================================================================
      const isComplete = result.isComplete || (result.stepState.status === "failed" && !willTriggerNext);
      
      if (isComplete && redis) {
        try {
          const replanKey = `exec:${executionId}:replan`;
          const replanData = await redis.get<any>(replanKey);

          if (replanData && replanData.shouldReplan) {
            console.log(
              `[ExecuteStep] Execution ${executionId} marked for replanning, triggering new plan...`
            );

            // Import planning functions
            const { generatePlan } = await import("@/lib/planner");
            const { inferIntent } = await import("@/lib/intent");

            // Build new user text from suggestions
            const suggestions = replanData.suggestions || [];
            const suggestionText = suggestions
              .map((s: any) => {
                if (s.type === "alternative_time") {
                  return `Try at ${s.value}`;
                }
                if (s.type === "delivery_alternative") {
                  return "Switch to delivery";
                }
                if (s.type === "waitlist_alternative") {
                  return "Join the waitlist";
                }
                return s.message || JSON.stringify(s.value);
              })
              .join(". ");

            const newRawText = `${replanData.originalIntent?.rawText || ""}. ${suggestionText}`.trim();

            // Re-infer intent with new context
            const { hypotheses } = await inferIntent(newRawText, []);
            const newIntent = hypotheses.primary;

            // Generate new plan with failover constraints
            const newPlan = await generatePlan(newRawText);

            // Update execution state with new plan
            const updatedState = await loadExecutionState(executionId);
            updatedState.intent = newIntent;
            updatedState.plan = newPlan;
            updatedState.status = "PLANNED";
            updatedState.step_states = newPlan.steps.map(() => ({
              status: "pending",
              error: null,
            }));

            await saveExecutionState(updatedState);

            // Clear replan marker
            await redis.del(replanKey);

            // Trigger first step of new plan
            await triggerNextStep(executionId, 0);

            console.log(
              `[ExecuteStep] Replanning complete for ${executionId}, new plan has ${newPlan.steps.length} steps`
            );
          }
        } catch (replanError) {
          console.warn("[ExecuteStep] Failed to execute replanning:", replanError);
          // Continue without replanning - not critical
        }
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
