/**
 * SagaOrchestrator Wrapper - Phase 3 Integration (Consolidated on WorkflowMachine)
 *
 * ⚠️ DEPRECATED: This is a compatibility wrapper. Use WorkflowMachine directly.
 *
 * Wrapper around WorkflowMachine for saga-pattern execution with automatic compensation.
 * All execution logic is consolidated in WorkflowMachine - this is a compatibility layer.
 *
 * @deprecated Use WorkflowMachine directly for all new development
 * @see {@link WorkflowMachine} for the unified execution engine
 */

import { WorkflowMachine, executeWorkflow, type WorkflowResult } from "./workflow-machine";
import { ToolExecutor as WorkflowToolExecutor } from "./workflow-machine";
import { Plan, ExecutionState } from "./types";
import { getCompensation, needsCompensation, IDEMPOTENT_TOOLS } from "@repo/mcp-protocol";
import { Tracer } from "./tracing";
import { createInitialState } from "./state-machine";

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
 * Uses WorkflowMachine for unified execution with saga compensation.
 *
 * Decision tree:
 * - Multi-step + compensatable → Use WorkflowMachine with saga
 * - Single-step or read-only → Use WorkflowMachine (standard)
 * - forceSaga=true → Always use WorkflowMachine with saga
 */
export async function executePlanWithSaga(
  plan: Plan,
  toolExecutor: WorkflowToolExecutor,
  options: SagaOrchestratorOptions = {}
): Promise<ExecutionResult> {
  const {
    enableSaga = true,
    forceSaga = false,
    sagaTimeoutMs = 120000,
    ...baseOptions
  } = options;

  const executionId = baseOptions.executionId || crypto.randomUUID();

  console.log(
    `[SagaOrchestrator] Using WorkflowMachine for plan with ${plan.steps.length} steps` +
    (hasCompensatableSteps(plan) ? " (compensatable)" : "")
  );

  return Tracer.startActiveSpan("saga_execution", async (span) => {
    const traceId = span.spanContext()?.traceId;

    // Create WorkflowMachine with initialState if provided
    const machine = new WorkflowMachine(executionId, toolExecutor, {
      initialState: baseOptions.initialState,
      intentId: baseOptions.initialState?.intent?.id,
      traceId,
      idempotencyService: baseOptions.idempotencyService,
    });

    // Set the plan
    machine.setPlan(plan);

    // Execute workflow (WorkflowMachine handles saga compensation automatically)
    const workflowResult = await machine.execute();

    // Convert workflow result to execution result
    const success = workflowResult.success;
    const wasCompensated = workflowResult.wasCompensated;

    span.setAttributes({
      workflow_success: success,
      workflow_compensated: wasCompensated,
      workflow_completed_steps: workflowResult.completedSteps,
      workflow_compensated_steps: workflowResult.compensatedSteps,
    });

    if (wasCompensated) {
      console.log(
        `[SagaOrchestrator] Plan failed after ${workflowResult.completedSteps} steps, ` +
        `successfully compensated ${workflowResult.compensatedSteps} steps`
      );
    }

    return {
      state: workflowResult.state,
      success,
      completed_steps: workflowResult.completedSteps,
      failed_steps: workflowResult.failedSteps,
      total_steps: workflowResult.totalSteps,
      execution_time_ms: workflowResult.executionTimeMs,
      summary: workflowResult.summary,
      error: workflowResult.error
        ? {
            code: workflowResult.error.code,
            message: workflowResult.error.message,
            step_id: workflowResult.error.stepId,
          }
        : undefined,
    };
  });
}

/**
 * Execution Result interface for compatibility
 */
export interface ExecutionResult {
  state: ExecutionState;
  success: boolean;
  completed_steps: number;
  failed_steps: number;
  total_steps: number;
  execution_time_ms: number;
  summary?: string;
  error?: {
    code: string;
    message: string;
    step_id?: string;
  };
}

/**
 * Export enhanced executePlan that uses saga by default
 */
export { executePlanWithSaga as executePlan };

// Re-export WorkflowMachine for direct access
export { WorkflowMachine, executeWorkflow };
export type { WorkflowToolExecutor as ToolExecutor };
