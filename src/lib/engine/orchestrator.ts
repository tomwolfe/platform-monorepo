/**
 * IntentionEngine - Execution Orchestrator
 * Phase 6: Execute plans with dependency resolution and state management
 */

import {
  ExecutionState,
  ExecutionStatus,
  Plan,
  PlanStep,
  StepExecutionState,
  TraceEntry,
  EngineErrorSchema,
  EngineErrorCode,
} from "./types";
import {
  ExecutionStateMachine,
  createInitialState,
  transitionState,
  updateStepState,
  applyStateUpdate,
  getStepState,
  getCompletedSteps,
  getPendingSteps,
} from "./state-machine";
import { saveExecutionState } from "./memory";
import { MCPClient } from "../../infrastructure/mcp/MCPClient";
import { getRegistryManager, RegistryManager } from "./registry";

// ============================================================================
// EXECUTION RESULT
// Result of execution operation
// ============================================================================

export interface ExecutionResult {
  state: ExecutionState;
  success: boolean;
  completed_steps: number;
  failed_steps: number;
  total_steps: number;
  execution_time_ms: number;
  error?: {
    code: string;
    message: string;
    step_id?: string;
    logs?: any;
  };
}

// ============================================================================
// TOOL EXECUTOR INTERFACE
// Abstraction for tool execution
// ============================================================================

export interface ToolExecutor {
  execute(
    toolName: string,
    parameters: Record<string, unknown>,
    timeoutMs: number
  ): Promise<{
    success: boolean;
    output?: unknown;
    error?: string;
    latency_ms: number;
  }>;
}

// ============================================================================
// STEP EXECUTION CONTEXT
// Context passed during step execution
// ============================================================================

interface StepExecutionContext {
  state: ExecutionState;
  step: PlanStep;
  toolExecutor: ToolExecutor;
  traceCallback?: (entry: TraceEntry) => void;
}

// ============================================================================
// CHECK STEP READY
// Determine if a step's dependencies are satisfied
// ============================================================================

function isStepReady(step: PlanStep, state: ExecutionState): boolean {
  if (step.dependencies.length === 0) {
    return true;
  }

  for (const depId of step.dependencies) {
    const depState = getStepState(state, depId);
    if (!depState || depState.status !== "completed") {
      return false;
    }
  }

  return true;
}

// ============================================================================
// RESOLVE STEP PARAMETERS
// Substitute parameter references with values from completed steps
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
// EXECUTE SINGLE STEP
// Execute one step with timeout and error handling
// ============================================================================

async function executeStep(
  context: StepExecutionContext
): Promise<StepExecutionState> {
  const { state, step, toolExecutor, traceCallback } = context;
  const stepStartTime = performance.now();
  const timestamp = new Date().toISOString();

  try {
    let stepState = updateStepState(state, step.id, {
      status: "in_progress",
      started_at: timestamp,
      attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
    });

    const resolvedParameters = resolveStepParameters(step, stepState);

    stepState = updateStepState(stepState, step.id, {
      input: resolvedParameters,
    });

    const toolResult = await toolExecutor.execute(
      step.tool_name,
      resolvedParameters,
      step.timeout_ms
    );

    const stepEndTime = performance.now();
    const latencyMs = Math.round(stepEndTime - stepStartTime);

    if (traceCallback) {
      traceCallback({
        timestamp,
        phase: "execution",
        step_id: step.id,
        event: toolResult.success ? "step_completed" : "step_failed",
        input: resolvedParameters,
        output: toolResult.success ? toolResult.output : undefined,
        error: toolResult.success ? undefined : toolResult.error,
        latency_ms: latencyMs,
      });
    }

    if (toolResult.success) {
      return {
        step_id: step.id,
        status: "completed",
        output: toolResult.output,
        completed_at: new Date().toISOString(),
        latency_ms: latencyMs,
        attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
      };
    } else {
      return {
        step_id: step.id,
        status: "failed",
        error: {
          code: "TOOL_EXECUTION_FAILED",
          message: toolResult.error || "Unknown tool execution error",
        },
        completed_at: new Date().toISOString(),
        latency_ms: latencyMs,
        attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
      };
    }
  } catch (error) {
    const stepEndTime = performance.now();
    const latencyMs = Math.round(stepEndTime - stepStartTime);

    const errorMessage =
      error instanceof Error ? error.message : String(error);

    if (traceCallback) {
      traceCallback({
        timestamp,
        phase: "execution",
        step_id: step.id,
        event: "step_error",
        error: errorMessage,
        latency_ms: latencyMs,
      });
    }

    return {
      step_id: step.id,
      status: "failed",
      error: {
        code: "STEP_EXECUTION_FAILED",
        message: errorMessage,
      },
      completed_at: new Date().toISOString(),
      latency_ms: latencyMs,
      attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
    };
  }
}

// ============================================================================
// FIND NEXT READY STEP
// Find a pending step whose dependencies are all completed
// ============================================================================

function findNextReadyStep(
  plan: Plan,
  state: ExecutionState
): PlanStep | null {
  const pendingSteps = getPendingSteps(state);

  for (const pendingStep of pendingSteps) {
    const planStep = plan.steps.find((s) => s.id === pendingStep.step_id);
    if (planStep && isStepReady(planStep, state)) {
      return planStep;
    }
  }

  return null;
}

// ============================================================================
// EXECUTE PLAN
// Main execution entry point
// ============================================================================

export async function executePlan(
  plan: Plan,
  toolExecutor: ToolExecutor,
  options: {
    executionId?: string;
    initialState?: ExecutionState;
    traceCallback?: (entry: TraceEntry) => void;
    persistState?: boolean;
  } = {}
): Promise<ExecutionResult> {
  const startTime = performance.now();
  const executionId = options.executionId || crypto.randomUUID();

  let state = options.initialState || createInitialState(executionId);
  state = applyStateUpdate(state, { plan });

  const transitionResult = transitionState(state, "EXECUTING");
  if (!transitionResult.success) {
    throw EngineErrorSchema.parse({
      code: "STATE_TRANSITION_INVALID",
      message: transitionResult.error || "Failed to transition to EXECUTING",
      recoverable: false,
      timestamp: new Date().toISOString(),
    });
  }

  state = applyStateUpdate(state, { status: "EXECUTING" });

  for (const step of plan.steps) {
    state = updateStepState(state, step.id, {
      status: "pending",
    });
  }

  if (options.persistState !== false) {
    await saveExecutionState(state);
  }

  try {
    while (true) {
      const nextStep = findNextReadyStep(plan, state);

      if (!nextStep) {
        const completedCount = getCompletedSteps(state).length;
        const failedCount = state.step_states.filter(
          (s) => s.status === "failed"
        ).length;
        const totalCount = plan.steps.length;

        if (completedCount + failedCount === totalCount) {
          break;
        } else {
          throw EngineErrorSchema.parse({
            code: "PLAN_CIRCULAR_DEPENDENCY",
            message: "Execution deadlock detected: pending steps exist but none are ready to execute",
            details: {
              completed: completedCount,
              failed: failedCount,
              pending: totalCount - completedCount - failedCount,
            },
            recoverable: false,
            timestamp: new Date().toISOString(),
          });
        }
      }

      const stepResult = await executeStep({
        state,
        step: nextStep,
        toolExecutor,
        traceCallback: options.traceCallback,
      });

      state = updateStepState(state, nextStep.id, stepResult);

      if (options.persistState !== false) {
        await saveExecutionState(state);
      }

      if (stepResult.status === "failed") {
        const endTime = performance.now();
        state = applyStateUpdate(state, {
          status: "FAILED",
          error: stepResult.error,
          completed_at: new Date().toISOString(),
        });

        if (options.persistState !== false) {
          await saveExecutionState(state);
        }

        return {
          state,
          success: false,
          completed_steps: getCompletedSteps(state).length,
          failed_steps: 1,
          total_steps: plan.steps.length,
          execution_time_ms: Math.round(endTime - startTime),
          error: stepResult.error
            ? {
                code: stepResult.error.code,
                message: stepResult.error.message,
                step_id: nextStep.id,
              }
            : undefined,
        };
      }
    }

    const endTime = performance.now();
    state = applyStateUpdate(state, {
      status: "COMPLETED",
      completed_at: new Date().toISOString(),
    });

    if (options.persistState !== false) {
      await saveExecutionState(state);
    }

    return {
      state,
      success: true,
      completed_steps: plan.steps.length,
      failed_steps: 0,
      total_steps: plan.steps.length,
      execution_time_ms: Math.round(endTime - startTime),
    };
  } catch (error) {
    const endTime = performance.now();
    const errorMessage = error instanceof Error ? error.message : String(error);

    state = applyStateUpdate(state, {
      status: "FAILED",
      error: {
        code: "UNKNOWN_ERROR",
        message: errorMessage,
      },
      completed_at: new Date().toISOString(),
    });

    if (options.persistState !== false) {
      await saveExecutionState(state);
    }

    return {
      state,
      success: false,
      completed_steps: getCompletedSteps(state).length,
      failed_steps: state.step_states.filter((s) => s.status === "failed").length,
      total_steps: plan.steps.length,
      execution_time_ms: Math.round(endTime - startTime),
      error: {
        code: "UNKNOWN_ERROR",
        message: errorMessage,
      },
    };
  }
}

// ============================================================================
// RESUME EXECUTION
// Resume execution from a persisted state
// ============================================================================

export async function resumeExecution(
  state: ExecutionState,
  toolExecutor: ToolExecutor,
  options: {
    traceCallback?: (entry: TraceEntry) => void;
    persistState?: boolean;
  } = {}
): Promise<ExecutionResult> {
  if (!state.plan) {
    throw EngineErrorSchema.parse({
      code: "PLAN_GENERATION_FAILED",
      message: "Cannot resume execution: no plan associated with state",
      recoverable: false,
      timestamp: new Date().toISOString(),
    });
  }

  if (
    state.status === "COMPLETED" ||
    state.status === "FAILED" ||
    state.status === "CANCELLED"
  ) {
    return {
      state,
      success: state.status === "COMPLETED",
      completed_steps: getCompletedSteps(state).length,
      failed_steps: state.step_states.filter((s) => s.status === "failed").length,
      total_steps: state.plan.steps.length,
      execution_time_ms: state.latency_ms,
    };
  }

  return executePlan(state.plan, toolExecutor, {
    executionId: state.execution_id,
    initialState: state,
    traceCallback: options.traceCallback,
    persistState: options.persistState,
  });
}

// ============================================================================
// EXECUTION ORCHESTRATOR CLASS
// ============================================================================

export class ExecutionOrchestrator {
  private toolExecutor: ToolExecutor;
  private traceCallback?: (entry: TraceEntry) => void;
  private vMcpClient?: MCPClient;
  private registryManager: RegistryManager;

  constructor(
    toolExecutor: ToolExecutor,
    options: { traceCallback?: (entry: TraceEntry) => void } = {}
  ) {
    this.toolExecutor = toolExecutor;
    this.traceCallback = options.traceCallback;
    this.registryManager = getRegistryManager();
    
    if (process.env.VERCEL_MCP_URL) {
      this.vMcpClient = new MCPClient(process.env.VERCEL_MCP_URL);
    }
  }

  /**
   * Initializes the orchestrator by discovering remote tools.
   */
  async initialize(): Promise<void> {
    await this.registryManager.discoverRemoteTools();
  }

  async execute(plan: Plan, executionId?: string): Promise<ExecutionResult> {
    try {
      return await executePlan(plan, this.toolExecutor, {
        executionId,
        traceCallback: this.traceCallback,
      });
    } catch (error: any) {
      if (error && error.code === "INFRASTRUCTURE_ERROR" && this.vMcpClient) {
        try {
          await this.vMcpClient.connect();
          const logs = await Promise.race([
            this.vMcpClient.callTool("get-logs", { 
              deploymentId: process.env.VERCEL_DEPLOYMENT_ID || "current" 
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error("MCP log fetch timeout")), 10000)
            )
          ]);
          
          await this.vMcpClient.disconnect();
          
          return {
            state: error.state || {} as any,
            success: false,
            completed_steps: 0,
            failed_steps: 1,
            total_steps: plan.steps.length,
            execution_time_ms: 0,
            error: {
              code: "INFRASTRUCTURE_ERROR",
              message: error.message,
              logs
            }
          };
        } catch (logError) {
          console.error("Failed to fetch Vercel logs via MCP:", logError);
        }
      }
      throw error;
    }
  }

  async resume(state: ExecutionState): Promise<ExecutionResult> {
    return resumeExecution(state, this.toolExecutor, {
      traceCallback: this.traceCallback,
    });
  }
}
