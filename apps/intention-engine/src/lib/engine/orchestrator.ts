/**
 * Execution Orchestrator
 *
 * Central orchestration service for intention parsing, planning, and execution triggering.
 * Extracted from the Next.js route handler to improve testability and separation of concerns.
 */

import { randomUUID } from "crypto";
import { withNervousSystemTracing } from "@repo/shared/tracing";
import { QStashService } from "@repo/shared";
import { AppConfig } from "@repo/shared";
import { startTrace } from "@/lib/observability";
import { saveUserInteractionContext } from "@/lib/context-persistence";
import {
  ExecutionState,
  ExecutionStatus,
  Intent,
  Plan,
  ExecutionTrace,
  ExecutionResult,
} from "@/lib/engine/types";
import {
  parseIntent,
  ParseResult,
  validateIntentConfidence,
} from "@/lib/engine/intent";
import { generatePlan, PlannerResult } from "@/lib/engine/planner";
import { getRegistryManager } from "@/lib/engine/registry";
import {
  createInitialState,
  transitionState,
  setIntent,
  setPlan,
} from "@/lib/engine/state-machine";
import { saveExecutionState, loadExecutionState } from "@/lib/engine/memory";
import { createTracer } from "@/lib/engine/tracing";
import { verifyPlan, DEFAULT_SAFETY_POLICY } from "@/lib/engine/verifier";

// Internal system key for QStash-triggered requests - uses strict getter
const INTERNAL_SYSTEM_KEY = AppConfig.getInternalSystemKey();

export interface OrchestrationContext {
  execution_id?: string;
  user_context?: Record<string, unknown>;
}

export interface OrchestrationOptions {
  skip_planning?: boolean;
  require_confirmation?: boolean;
}

export interface OrchestrationResult {
  success: boolean;
  execution_id: string;
  status: ExecutionStatus;
  intent?: Intent;
  plan?: Plan;
  execution_result?: ExecutionResult;
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
  };
}

/**
 * Orchestrates the full intention parsing, planning, and execution triggering flow.
 *
 * @param input - User's natural language input
 * @param context - Execution context (execution_id, user_context)
 * @param options - Orchestration options (skip_planning, require_confirmation)
 * @returns Orchestration result with status, intent, plan, and metadata
 */
export async function orchestrateExecution(
  input: string,
  context: OrchestrationContext = {},
  options: OrchestrationOptions = {},
): Promise<OrchestrationResult> {
  const startTime = performance.now();
  const executionId = context.execution_id || randomUUID();

  return await withNervousSystemTracing(
    async ({ correlationId }) => {
      const span = startTrace("orchestration", correlationId);

      // Initialize Registry and Discovery
      const registryManager = getRegistryManager();
      await registryManager.discoverRemoteTools();

      // Initialize tracer
      const tracer = createTracer(executionId);
      tracer.addSystemEntry("execution_started", {
        input: input.slice(0, 100),
      });

      try {
        // Step 1: Create initial state
        let state = createInitialState(executionId);
        tracer.addStateTransitionEntry("none", "RECEIVED", true);

        // Persist initial state
        await saveExecutionState(state);

        // Step 2: Parse intent
        tracer.addSystemEntry("parsing_intent");
        const parseResult: ParseResult = await parseIntent(input, {
          execution_id: executionId,
          user_context: context.user_context,
        });

        // Add intent trace entry
        tracer.addIntentEntry(
          input,
          parseResult.intent,
          parseResult.latency_ms,
          parseResult.intent.metadata.model_id || "unknown",
          {
            prompt: parseResult.token_usage.prompt_tokens,
            completion: parseResult.token_usage.completion_tokens,
          },
        );

        // Update state with intent
        state = setIntent(state, parseResult.intent);
        await saveExecutionState(state);

        // Validate intent confidence and type
        const validation = validateIntentConfidence(parseResult.intent);

        if (!validation.valid) {
          tracer.addSystemEntry("intent_rejected", {
            reason: validation.reason,
          });

          const traceResult = tracer.finalize();
          span.end();

          return {
            success: false,
            execution_id: executionId,
            status: "REJECTED",
            intent: parseResult.intent,
            error: {
              code: "INTENT_VALIDATION_FAILED",
              message: validation.reason || "Intent validation failed",
            },
            trace: traceResult.trace,
            metadata: {
              duration_ms: Math.round(performance.now() - startTime),
              total_tokens: traceResult.totalTokenUsage.totalTokens,
              trace_id: executionId,
              total_ms: Math.round(performance.now() - startTime),
            },
          };
        }

        // Save interaction context for conversational continuity (Objective 5)
        // Extract user ID from context if available
        const userId = context.user_context?.userId as string | undefined;
        if (userId) {
          await saveUserInteractionContext(userId, {
            intentType: parseResult.intent.type,
            rawText: parseResult.intent.rawText,
            parameters: parseResult.intent.parameters as Record<
              string,
              unknown
            >,
            timestamp: new Date().toISOString(),
            executionId,
          });
        }

        // Check if intent requires clarification
        if (parseResult.intent.requires_clarification) {
          tracer.addSystemEntry("clarification_required", {
            prompt: parseResult.intent.clarification_prompt,
          });

          const traceResult = tracer.finalize();
          span.end();

          return {
            success: false,
            execution_id: executionId,
            status: "REJECTED",
            intent: parseResult.intent,
            error: {
              code: "CLARIFICATION_REQUIRED",
              message:
                parseResult.intent.clarification_prompt ||
                "Additional information needed",
            },
            trace: traceResult.trace,
            metadata: {
              duration_ms: Math.round(performance.now() - startTime),
              total_tokens: traceResult.totalTokenUsage.totalTokens,
              trace_id: executionId,
              total_ms: Math.round(performance.now() - startTime),
            },
          };
        }

        // Step 3: Generate plan (unless skipped)
        let plan: Plan | undefined;
        if (!options.skip_planning) {
          tracer.addSystemEntry("generating_plan");
          const planResult: PlannerResult = await generatePlan(
            parseResult.intent,
            {
              execution_id: executionId,
              available_tools: registryManager.listAllTools(),
            },
          );

          // Add planning trace entry
          tracer.addPlanningEntry(
            { intent_type: parseResult.intent.type },
            {
              plan_id: planResult.plan.id,
              steps: planResult.plan.steps.length,
            },
            planResult.latency_ms,
            planResult.trace_entry.model_id || "unknown",
            {
              prompt: planResult.token_usage.prompt_tokens,
              completion: planResult.token_usage.completion_tokens,
            },
          );

          plan = planResult.plan;

          // Step 3.5: Deterministic Verification Gate
          const verification = verifyPlan(plan, DEFAULT_SAFETY_POLICY);
          if (!verification.valid) {
            tracer.addSystemEntry("plan_rejected", {
              reason: verification.reason,
              violation: verification.violation,
            });

            // Transition state to REJECTED
            state = transitionState(state, "REJECTED");
            await saveExecutionState(state);

            const traceResult = tracer.finalize();
            span.end();

            return {
              success: false,
              execution_id: executionId,
              status: "REJECTED",
              intent: parseResult.intent,
              plan,
              error: {
                code: verification.violation || "PLAN_VALIDATION_FAILED",
                message: verification.reason || "Plan verification failed",
              },
              trace: traceResult.trace,
              metadata: {
                duration_ms: Math.round(performance.now() - startTime),
                total_tokens: traceResult.totalTokenUsage.totalTokens,
                trace_id: executionId,
                total_ms: Math.round(performance.now() - startTime),
              },
            };
          }

          state = setPlan(state, plan);
          await saveExecutionState(state);
        }

        // Step 4: TRIGGER ASYNC EXECUTION VIA QSTASH (Vercel Hobby Pattern)
        // Instead of executing synchronously, we trigger Step 0 via QStash and return immediately
        if (plan) {
          tracer.addSystemEntry("triggering_async_execution", {
            step_count: plan.steps.length,
          });

          // Trigger the FIRST step via QStash
          // This starts the recursive self-trigger chain
          // CRITICAL: Pass trace context for distributed tracing
          await QStashService.triggerNextStep({
            executionId,
            stepIndex: 0,
            internalKey: INTERNAL_SYSTEM_KEY,
            traceId: executionId, // Use executionId as initial traceId
            correlationId: executionId,
          });

          // Finalize trace
          const traceResult = tracer.finalize();
          span.end();

          // Return immediately - execution will happen asynchronously
          return {
            success: true,
            execution_id: executionId,
            status: "STARTED",
            intent: parseResult.intent,
            plan,
            trace: traceResult.trace,
            metadata: {
              duration_ms: Math.round(performance.now() - startTime),
              total_tokens: traceResult.totalTokenUsage.totalTokens,
              step_count: plan.steps.length,
              trace_id: executionId,
              total_ms: Math.round(performance.now() - startTime),
            },
          };
        } else {
          // No plan to execute (planning skipped or no plan generated)
          const traceResult = tracer.finalize();
          span.end();

          return {
            success: true,
            execution_id: executionId,
            status: "PLANNED",
            intent: parseResult.intent,
            plan,
            trace: traceResult.trace,
            metadata: {
              duration_ms: Math.round(performance.now() - startTime),
              total_tokens: traceResult.totalTokenUsage.totalTokens,
              trace_id: executionId,
              total_ms: Math.round(performance.now() - startTime),
            },
          };
        }
      } catch (error) {
        // Handle orchestration errors
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorCode =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "ORCHESTRATION_ERROR";

        tracer.addErrorEntry("system", errorCode, errorMessage);
        const traceResult = tracer.finalize();
        span.end();

        return {
          success: false,
          execution_id: executionId,
          status: "FAILED",
          error: {
            code: errorCode,
            message: errorMessage,
          },
          trace: traceResult.trace,
          metadata: {
            duration_ms: Math.round(performance.now() - startTime),
            total_tokens: traceResult.totalTokenUsage.totalTokens,
            trace_id: executionId,
            total_ms: Math.round(performance.now() - startTime),
          },
        };
      }
    },
    { "x-trace-id": executionId },
  );
}

/**
 * Retrieves the execution status for a given execution ID.
 *
 * @param executionId - The execution ID to look up
 * @returns Execution status and state information
 */
export async function getExecutionStatus(executionId: string): Promise<{
  success: boolean;
  state?: ExecutionState;
  trace?: ExecutionTrace;
  error?: { code: string; message: string };
}> {
  try {
    const state = await loadExecutionState(executionId);

    if (!state) {
      return {
        success: false,
        error: {
          code: "EXECUTION_NOT_FOUND",
          message: `Execution ${executionId} not found`,
        },
      };
    }

    return {
      success: true,
      state,
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: "LOAD_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
