/**
 * Execution Orchestrator
 *
 * Central orchestration service for intention parsing, planning, and execution triggering.
 * Refactored to use step-based composition via executeStepSequence.
 *
 * @see orchestrator/steps/ for individual step implementations
 */

import { randomUUID } from "crypto";
import { withNervousSystemTracing } from "@repo/shared/tracing";
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
import { createTracer } from "@/lib/engine/tracing";
import { loadExecutionState } from "@/lib/engine/memory";
import {
  executeStepSequence,
  getStepRegistry,
} from "./orchestrator/step-registry";
import {
  ExecutionRecord,
  StepStatus,
} from "./orchestrator/step-registry-types";
import { ParseIntentStep } from "./orchestrator/steps/parse-intent-step";
import { ValidateIntentStep } from "./orchestrator/steps/validate-intent-step";
import { GeneratePlanStep } from "./orchestrator/steps/generate-plan-step";
import { VerifyPlanStep } from "./orchestrator/steps/verify-plan-step";
import { TriggerExecutionStep } from "./orchestrator/steps/trigger-execution-step";
import { InitializeStateStep } from "./orchestrator/steps/initialize-state-step";

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
 * Build the step sequence for orchestration
 */
function buildStepSequence(options: OrchestrationOptions) {
  const registry = getStepRegistry();
  registry.clear();

  // Register all steps
  registry.register(new InitializeStateStep());
  registry.register(new ParseIntentStep());
  registry.register(new ValidateIntentStep());
  registry.register(new GeneratePlanStep());
  registry.register(new VerifyPlanStep());
  registry.register(new TriggerExecutionStep());

  // Define execution order
  registry.defineSequence([
    "initialize_state",
    "parse_intent",
    "validate_intent",
    "generate_plan",
    "verify_plan",
    "trigger_execution",
  ]);

  return registry.getSequence();
}

/**
 * Build the result object from context and execution metadata
 */
function buildResult(
  executionId: string,
  startTime: number,
  context: import("./step-registry-types").OrchestrationContext,
  executionLog: ExecutionRecord[],
  status: ExecutionStatus,
  success: boolean,
  error?: { code: string; message: string },
): OrchestrationResult {
  // Calculate total tokens from execution log
  const totalTokens = 0; // TODO: aggregate from correlations when available

  return {
    success,
    execution_id: executionId,
    status,
    intent: context.intent,
    plan: context.plan,
    error,
    trace: context.trace || { entries: [], total_token_usage: { totalTokens } },
    metadata: {
      duration_ms: Math.round(performance.now() - startTime),
      total_tokens: totalTokens,
      step_count: executionLog.length,
      trace_id: executionId,
      total_ms: Math.round(performance.now() - startTime),
    },
  };
}

/**
 * Orchestrates the full intention parsing, planning, and execution triggering flow.
 *
 * Uses step-based composition via executeStepSequence for better testability,
 * rollback support, and separation of concerns.
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

      try {
        // Build step sequence
        const steps = buildStepSequence(options);

        // Build initial context for step execution
        const stepContext = {
          input,
          executionId,
          userContext: context.user_context,
          skipPlanning: options.skip_planning,
          requireConfirmation: options.require_confirmation,
          startTime,
        };

        // Execute steps in sequence
        const {
          context: finalContext,
          executionLog,
          success,
        } = await executeStepSequence(steps, stepContext, (record) => {
          // Optional: hook for per-step completion callbacks
          // e.g., persist step results, update metrics, etc.
        });

        // Handle post-sequence logic
        if (!success) {
          // Determine failure reason from execution log
          const failedRecord = executionLog.find(
            (r) => r.status === StepStatus.FAILED,
          );
          const error = failedRecord?.error;
          const errorCode =
            error && "code" in error
              ? String((error as any).code)
              : "ORCHESTRATION_ERROR";
          const errorMessage = error?.message || "Step execution failed";

          const result = buildResult(
            executionId,
            startTime,
            finalContext,
            executionLog,
            "REJECTED",
            false,
            { code: errorCode, message: errorMessage },
          );
          span.end();
          return result;
        }

        // Save interaction context for conversational continuity
        const userId = context.user_context?.userId as string | undefined;
        if (userId && finalContext.intent) {
          await saveUserInteractionContext(userId, {
            intentType: finalContext.intent.type,
            rawText: finalContext.intent.rawText,
            parameters: finalContext.intent.parameters as Record<
              string,
              unknown
            >,
            timestamp: new Date().toISOString(),
            executionId,
          });
        }

        // Check if plan was generated (planning may have been skipped)
        const hasPlan = !!finalContext.plan;

        const result = buildResult(
          executionId,
          startTime,
          finalContext,
          executionLog,
          hasPlan ? "STARTED" : "PLANNED",
          true,
        );
        span.end();
        return result;
      } catch (error) {
        // Handle orchestration-level errors (outside step sequence)
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorCode =
          error && typeof error === "object" && "code" in error
            ? String((error as any).code)
            : "ORCHESTRATION_ERROR";

        const tracer = createTracer(executionId);
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
