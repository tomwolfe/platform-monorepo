/**
 * SagaOrchestrator Wrapper - Phase 3 Integration
 * 
 * Wraps the existing executePlan with Saga pattern for automatic compensation.
 * Uses SagaManager for multi-step state-modifying plans, falls back to
 * standard execution for single-step or read-only plans.
 */

import { executePlan, ToolExecutor, ExecutionResult } from "./orchestrator";
import { SagaManager, createSagaStep, SagaStatus, CompensationMappers } from "./saga";
import { Plan, ExecutionState } from "./types";
import { getCompensation, needsCompensation, IDEMPOTENT_TOOLS } from "@repo/mcp-protocol";
import { Tracer } from "./tracing";

export interface SagaOrchestratorOptions {
  executionId?: string;
  initialState?: ExecutionState;
  traceCallback?: (entry: any) => void;
  persistState?: boolean;
  idempotencyService?: any;
  /** Enable saga mode (default: true for multi-step plans) */
  enableSaga?: boolean;
  /** Force saga even for single-step plans */
  forceSaga?: boolean;
  /** Saga timeout in milliseconds (default: 120000) */
  sagaTimeoutMs?: number;
}

/**
 * Check if a plan contains state-modifying steps that need compensation
 */
function hasCompensatableSteps(plan: Plan): boolean {
  return plan.steps.some(step => needsCompensation(step.tool_name));
}

/**
 * Check if plan has multiple steps (candidate for saga)
 */
function isMultiStepPlan(plan: Plan): boolean {
  return plan.steps.length > 1;
}

/**
 * SagaOrchestrator provides automatic compensation for multi-step plans.
 * 
 * Decision tree:
 * - Multi-step + compensatable → Use SagaManager
 * - Single-step or read-only → Use standard executePlan
 * - forceSaga=true → Always use SagaManager
 */
export async function executePlanWithSaga(
  plan: Plan,
  toolExecutor: ToolExecutor,
  options: SagaOrchestratorOptions = {}
): Promise<ExecutionResult> {
  const {
    enableSaga = true,
    forceSaga = false,
    sagaTimeoutMs = 120000,
    ...baseOptions
  } = options;

  const shouldUseSaga = enableSaga && (
    forceSaga ||
    (isMultiStepPlan(plan) && hasCompensatableSteps(plan))
  );

  if (!shouldUseSaga) {
    // Fall back to standard execution
    console.log(`[SagaOrchestrator] Using standard execution for plan with ${plan.steps.length} steps`);
    return executePlan(plan, toolExecutor, baseOptions);
  }

  console.log(`[SagaOrchestrator] Using Saga pattern for plan with ${plan.steps.length} compensatable steps`);

  return Tracer.startActiveSpan("saga_execution", async (span) => {
    const executionId = baseOptions.executionId || crypto.randomUUID();
    const traceId = span.spanContext()?.traceId;

    // Create saga manager
    const sagaManager = new SagaManager(toolExecutor);

    // Convert plan steps to saga steps
    const sagaSteps = plan.steps.map((step, index) => {
      const compensation = getCompensation(step.tool_name);
      
      let parameterMapper: any = undefined;
      if (compensation) {
        // Map compensation type to mapper function
        switch (compensation.parameterMapper) {
          case "use_booking_id":
            parameterMapper = CompensationMappers.useResultId("booking_id");
            break;
          case "use_order_id":
            parameterMapper = CompensationMappers.useResultId("order_id");
            break;
          case "use_reservation_id":
            parameterMapper = CompensationMappers.useResultId("reservation_id");
            break;
          case "use_fulfillment_id":
            parameterMapper = CompensationMappers.useResultId("fulfillmentId");
            break;
          case "identity":
          default:
            parameterMapper = () => ({});
        }
      }

      return createSagaStep(
        step.id,
        step.tool_name,
        step.parameters,
        compensation?.toolName
          ? {
              toolName: compensation.toolName,
              parameterMapper,
            }
          : undefined
      );
    });

    try {
      const sagaResult = await sagaManager.execute({
        context: {
          sagaId: crypto.randomUUID(),
          executionId,
          intentId: baseOptions.initialState?.intent?.id,
          traceId,
          userId: baseOptions.initialState?.context?.userId as string | undefined,
          metadata: {
            planSummary: plan.summary,
            originalStepCount: plan.steps.length,
          },
        },
        steps: sagaSteps,
        timeoutMs: sagaTimeoutMs,
      });

      // Convert saga result to execution result
      const success = sagaResult.status === SagaStatus.COMPLETED;
      const wasCompensated = sagaResult.status === SagaStatus.COMPENSATED;

      span.setAttributes({
        saga_status: sagaResult.status,
        saga_compensated: wasCompensated,
        saga_completed_steps: sagaResult.completedSteps,
        saga_compensated_steps: sagaResult.compensatedSteps,
      });

      if (wasCompensated) {
        console.log(
          `[SagaOrchestrator] Plan failed after ${sagaResult.completedSteps} steps, ` +
          `successfully compensated ${sagaResult.compensatedSteps} steps`
        );
      }

      return {
        state: sagaResultToExecutionState(sagaResult, baseOptions.initialState || createInitialState(executionId)),
        success,
        completed_steps: sagaResult.completedSteps,
        failed_steps: sagaResult.failedSteps,
        total_steps: plan.steps.length,
        execution_time_ms: sagaResult.completedAt
          ? new Date(sagaResult.completedAt).getTime() - new Date(sagaResult.startedAt).getTime()
          : 0,
        summary: success
          ? `Saga completed successfully with ${sagaResult.completedSteps} steps`
          : wasCompensated
          ? `Saga failed after step ${sagaResult.failedSteps + 1}, compensated ${sagaResult.compensatedSteps} steps`
          : `Saga failed: ${sagaResult.error?.message}`,
        error: sagaResult.error
          ? {
              code: sagaResult.error.code,
              message: sagaResult.error.message,
              step_id: sagaResult.error.failedStepId,
            }
          : undefined,
      };
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  });
}

/**
 * Convert saga result to execution state
 */
function sagaResultToExecutionState(
  sagaResult: any,
  initialState: ExecutionState
): ExecutionState {
  // This is a simplified conversion - in production you'd want
  // to properly map saga results to the execution state machine
  return {
    ...initialState,
    status: sagaResult.status === "COMPLETED" ? "COMPLETED" : "FAILED",
    step_states: sagaResult.steps.map((step: any, index: number) => ({
      step_id: step.id,
      status: step.status === "completed" ? "completed" :
              step.status === "compensated" ? "compensated" :
              step.status === "failed" ? "failed" : "pending",
      input: step.parameters,
      output: step.result,
      error: step.error,
      completed_at: step.completedAt,
      started_at: step.startedAt,
      attempts: 1,
    })),
    completed_at: sagaResult.completedAt,
    error: sagaResult.error,
  };
}

/**
 * Create initial execution state (minimal implementation)
 */
function createInitialState(executionId: string): ExecutionState {
  return {
    execution_id: executionId,
    status: "PLANNED",
    step_states: [],
    intent: undefined,
    plan: undefined,
    context: {},
    current_step_index: 0,
    latency_ms: 0,
    token_usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

/**
 * Export enhanced executePlan that uses saga by default
 */
export { executePlanWithSaga as executePlan };
