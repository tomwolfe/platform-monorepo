/**
 * DurableExecutionManager - State-Machine Execution with Checkpointing
 *
 * Vercel Hobby Tier Optimization:
 * - State-Machine Task Queue pattern for durable execution
 * - Atomic state transitions stored in Upstash Redis
 * - QStash-style scheduled triggers for execution resumption
 * - Ably webhook callbacks for continuation signaling
 *
 * Architecture:
 * 1. Executes steps until ~7 seconds elapsed
 * 2. Saves state transition to Redis (TaskState)
 * 3. Schedules resume via scheduleTaskResume (QStash pattern)
 * 4. Publishes CONTINUE_EXECUTION event to Ably for webhook trigger
 * 5. Returns partial response to client
 * 6. /api/mesh/resume picks up execution from TaskState
 */

import {
  ExecutionState,
  ExecutionStatus,
  Plan,
  PlanStep,
  StepExecutionState,
  TraceEntry,
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
import { saveExecutionState, loadExecutionState } from "./memory";
import { RealtimeService, MemoryClient, getMemoryClient as getSharedMemoryClient } from "@repo/shared";
import { getAblyClient, TaskState, TaskStatus } from "@repo/shared";
import { Tracer } from "./tracing";
import { getToolRegistry } from "./tools/registry";
import { generateText } from "./llm";
import {
  validateBeforeExecution,
  extractErrorCode,
  isClientOrServerError,
  attemptErrorRecovery,
  logExecutionResults,
} from "./execution-helpers";
import { IdempotencyService } from "@repo/shared";

// ============================================================================
// CONFIGURATION
// Vercel Hobby Tier Optimization
// ============================================================================

const VERCEL_TIMEOUT_MS = 10000; // Vercel kills lambdas at 10s
const CHECKPOINT_THRESHOLD_MS = 7000; // Save state at 7s to allow 3s buffer
const SEGMENT_TIMEOUT_MS = 8500; // Abort individual steps at 8.5s

// ============================================================================
// CHECKPOINT SCHEMA
// Persisted state for resuming execution
// ============================================================================

export interface ExecutionCheckpoint {
  executionId: string;
  intentId?: string;
  planId?: string;
  // Current execution state (serialized)
  state: ExecutionState;
  // Index of next step to execute
  nextStepIndex: number;
  // Steps completed in this segment
  completedInSegment: number;
  // Segment number (for observability)
  segmentNumber: number;
  // Timestamp when checkpoint was created
  checkpointAt: string;
  // Trace ID for distributed tracing
  traceId?: string;
  // Reason for checkpoint (timeout, segmentation, etc.)
  reason: "TIMEOUT_APPROACHING" | "SEGMENT_COMPLETE" | "ERROR_RECOVERY";
}

// ============================================================================
// DURABLE EXECUTION RESULT
// Extended result with segmentation info
// ============================================================================

export interface DurableExecutionResult {
  state: ExecutionState;
  success: boolean;
  completed_steps: number;
  failed_steps: number;
  total_steps: number;
  execution_time_ms: number;
  // Segmentation info
  isPartial: boolean;
  checkpointCreated?: boolean;
  nextStepIndex?: number;
  segmentNumber?: number;
  continuationEventPublished?: boolean;
  // Standard fields
  summary?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number;
  };
  error?: {
    code: string;
    message: string;
    step_id?: string;
    logs?: any;
  };
}

// ============================================================================
// TOOL EXECUTOR INTERFACE
// ============================================================================

export interface ToolExecutor {
  execute(
    toolName: string,
    parameters: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{
    success: boolean;
    output?: unknown;
    error?: string;
    latency_ms: number;
    compensation?: {
      toolName: string;
      parameters?: Record<string, unknown>;
    };
  }>;
}

// ============================================================================
// STEP EXECUTION CONTEXT
// ============================================================================

interface StepExecutionContext {
  state: ExecutionState;
  step: PlanStep;
  toolExecutor: ToolExecutor;
  traceCallback?: (entry: TraceEntry) => void;
  idempotencyService?: IdempotencyService;
  segmentStartTime: number;
  traceId?: string;
}

// ============================================================================
// CHECKPOINT MANAGER
// Handles Redis persistence and Ably signaling
// Vercel Hobby Tier Optimization: Uses Task Queue pattern
// ============================================================================

export class CheckpointManager {
  private static memoryClient: MemoryClient | null = null;

  private static getMemoryClient(): MemoryClient {
    if (!this.memoryClient) {
      this.memoryClient = getSharedMemoryClient();
    }
    return this.memoryClient!;
  }

  /**
   * Saves execution state as a TaskState transition.
   * Vercel Hobby Tier Optimization: Atomic state machine pattern.
   */
  static async saveCheckpoint(checkpoint: ExecutionCheckpoint): Promise<void> {
    const memory = this.getMemoryClient();

    try {
      // Create or update TaskState
      const taskState: TaskState = {
        task_id: checkpoint.executionId,
        execution_id: checkpoint.executionId,
        intent_id: checkpoint.intentId,
        status: "in_progress",
        current_step_index: checkpoint.nextStepIndex,
        total_steps: checkpoint.state.plan?.steps.length || 0,
        segment_number: checkpoint.segmentNumber,
        created_at: checkpoint.checkpointAt,
        updated_at: checkpoint.checkpointAt,
        transitions: [{
          from_status: "in_progress",
          to_status: "in_progress",
          timestamp: checkpoint.checkpointAt,
          reason: checkpoint.reason,
          metadata: {
            segmentNumber: checkpoint.segmentNumber,
            nextStepIndex: checkpoint.nextStepIndex,
            completedInSegment: checkpoint.completedInSegment,
          },
        }],
        context: {
          execution_state: checkpoint.state,
          priority: checkpoint.segmentNumber,
        },
      };

      // Store task state (creates or updates)
      await memory.updateTaskContext(checkpoint.executionId, {
        execution_state: checkpoint.state,
        last_checkpoint_at: checkpoint.checkpointAt,
        segment_number: checkpoint.segmentNumber,
        next_step_index: checkpoint.nextStepIndex,
      });

      console.log(
        `[DurableExecution] TaskState updated for ${checkpoint.executionId} ` +
        `[segment ${checkpoint.segmentNumber}, next step: ${checkpoint.nextStepIndex}]`
      );
    } catch (error) {
      console.error("[DurableExecution] Failed to save checkpoint:", error);
      throw error;
    }
  }

  /**
   * Schedules execution resume using QStash-style pattern.
   * Vercel Hobby Tier Optimization: Time-based trigger.
   */
  static async scheduleResume(
    executionId: string,
    checkpoint: ExecutionCheckpoint
  ): Promise<void> {
    const memory = this.getMemoryClient();

    try {
      // Schedule resume in 2 seconds (gives time for webhook to trigger)
      await memory.scheduleTaskResume(executionId, 2, {
        intent_id: checkpoint.intentId,
        plan_id: checkpoint.planId,
        start_step_index: checkpoint.nextStepIndex,
        segment_number: checkpoint.segmentNumber,
        trace_id: checkpoint.traceId,
      });

      console.log(
        `[DurableExecution] Scheduled resume for ${executionId} ` +
        `[segment ${checkpoint.segmentNumber}]`
      );
    } catch (error) {
      console.error("[DurableExecution] Failed to schedule resume:", error);
      throw error;
    }
  }

  /**
   * Loads execution state from TaskState.
   */
  static async loadCheckpoint(executionId: string): Promise<ExecutionCheckpoint | null> {
    const memory = this.getMemoryClient();

    try {
      const taskState = await memory.getTaskState(executionId);
      if (!taskState) return null;

      const executionState = taskState.context.execution_state as ExecutionState;
      if (!executionState) return null;

      return {
        executionId,
        intentId: taskState.intent_id,
        planId: executionState.plan?.id,
        state: executionState,
        nextStepIndex: taskState.current_step_index,
        completedInSegment: 0,
        segmentNumber: taskState.segment_number,
        checkpointAt: taskState.updated_at,
        traceId: undefined,
        reason: "TIMEOUT_APPROACHING",
      };
    } catch (error) {
      console.error("[DurableExecution] Failed to load checkpoint:", error);
      return null;
    }
  }

  static async deleteCheckpoint(executionId: string): Promise<void> {
    // TaskState will auto-expire after 24h
    console.log(`[DurableExecution] Checkpoint marked for cleanup: ${executionId}`);
  }

  static async publishContinuationEvent(
    executionId: string,
    checkpoint: ExecutionCheckpoint
  ): Promise<void> {
    try {
      await RealtimeService.publishNervousSystemEvent(
        "CONTINUE_EXECUTION",
        {
          executionId,
          intentId: checkpoint.intentId,
          planId: checkpoint.planId,
          nextStepIndex: checkpoint.nextStepIndex,
          segmentNumber: checkpoint.segmentNumber,
          traceId: checkpoint.traceId,
          timestamp: new Date().toISOString(),
        },
        checkpoint.traceId
      );

      console.log(
        `[DurableExecution] Published CONTINUE_EXECUTION for ${executionId} ` +
        `[trace: ${checkpoint.traceId}]`
      );
    } catch (error) {
      console.error("[DurableExecution] Failed to publish continuation event:", error);
      throw error;
    }
  }
}

// ============================================================================
// EXECUTE STEP WITH CHECKPOINTING
// Wraps step execution with timeout monitoring
// ============================================================================

async function executeStepWithCheckpointing(
  context: StepExecutionContext
): Promise<{
  stepState: StepExecutionState;
  timedOut: boolean;
  compensation?: {
    toolName: string;
    parameters?: Record<string, unknown>;
  };
}> {
  const { state, step, toolExecutor, traceCallback, idempotencyService, segmentStartTime, traceId } = context;
  const stepStartTime = performance.now();
  const timestamp = new Date().toISOString();
  const stepIndex = state.step_states.findIndex(s => s.step_id === step.id) ?? 0;
  const totalSteps = state.step_states.length;

  return await Tracer.startActiveSpan(`execute_step:${step.tool_name}`, async (span) => {
    const toolDef = getToolRegistry().getDefinition(step.tool_name);
    span.setAttributes({
      intent_id: state.intent?.id || "unknown",
      step_type: step.tool_name,
      mcp_server_origin: toolDef?.origin || "local",
      trace_id: traceId || "unknown",
    });

    try {
      // IDEMPOTENCY CHECK
      const idempotencyKey = `${state.intent?.id || state.execution_id}:${stepIndex}`;
      if (idempotencyService) {
        const isDuplicate = await idempotencyService.isDuplicate(idempotencyKey, step.tool_name);
        if (isDuplicate) {
          console.log(`[Idempotency] Step ${step.tool_name} (${step.id}) already executed, skipping`);
          span.setAttributes({ idempotency_skip: true });

          await RealtimeService.publishStreamingStatusUpdate({
            executionId: state.execution_id,
            stepIndex,
            totalSteps,
            stepName: step.tool_name,
            status: 'completed',
            message: 'Skipped (idempotent)',
            timestamp: new Date().toISOString(),
            traceId: span?.spanContext()?.traceId,
          });

          return {
            stepState: {
              step_id: step.id,
              status: "completed",
              output: { skipped: true, reason: "Already executed (idempotent)" },
              completed_at: new Date().toISOString(),
              latency_ms: 0,
              attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
            },
            timedOut: false,
          };
        }
      }

      let stepState = updateStepState(state, step.id, {
        status: "in_progress",
        started_at: timestamp,
        attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
      });

      // Resolve parameter references
      const resolvedParameters = resolveStepParameters(step, stepState);

      // Dynamic Parameter Bridge
      if (toolDef?.parameter_aliases) {
        for (const [alias, primary] of Object.entries(toolDef.parameter_aliases)) {
          if (resolvedParameters[alias] !== undefined && resolvedParameters[primary] === undefined) {
            resolvedParameters[primary] = resolvedParameters[alias];
          }
        }
      }

      // Validation before execution
      const validationResult = await validateBeforeExecution(step, resolvedParameters);
      if (!validationResult.valid) {
        return {
          stepState: {
            step_id: step.id,
            status: "failed",
            error: {
              code: "VALIDATION_FAILED",
              message: validationResult.error || "Pre-execution validation failed",
            },
            completed_at: new Date().toISOString(),
            latency_ms: 0,
            attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
          },
          timedOut: false,
        };
      }

      // PRE-EMPTIVE CHECKPOINTING - Save before tool call
      stepState = updateStepState(stepState, step.id, {
        input: resolvedParameters,
      });
      await saveExecutionState(stepState);

      // STREAMING STATUS UPDATE - Step Start
      await RealtimeService.publishStreamingStatusUpdate({
        executionId: state.execution_id,
        stepIndex,
        totalSteps,
        stepName: step.tool_name,
        status: 'in_progress',
        message: `Starting ${step.description || step.tool_name}...`,
        timestamp: new Date().toISOString(),
        traceId: traceId,
      });

      // ABORT CONTROLLER WITH 8500MS TIMEOUT
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        console.warn(
          `[Durable Execution] Step ${step.tool_name} approaching Vercel timeout, aborting...`
        );
        abortController.abort();
      }, SEGMENT_TIMEOUT_MS);

      let toolResult: Awaited<ReturnType<ToolExecutor["execute"]>>;
      try {
        toolResult = await toolExecutor.execute(
          step.tool_name,
          resolvedParameters,
          step.timeout_ms,
          abortController.signal
        );
      } finally {
        clearTimeout(timeoutId);
      }

      const stepEndTime = performance.now();
      const latencyMs = Math.round(stepEndTime - stepStartTime);
      const elapsedInSegment = Date.now() - segmentStartTime;

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

      // Check if we're approaching timeout after step completion
      const timedOut = elapsedInSegment >= CHECKPOINT_THRESHOLD_MS;

      if (toolResult.success) {
        await RealtimeService.publishStreamingStatusUpdate({
          executionId: state.execution_id,
          stepIndex,
          totalSteps,
          stepName: step.tool_name,
          status: 'completed',
          message: `Completed ${step.description || step.tool_name}`,
          timestamp: new Date().toISOString(),
          traceId: traceId,
        });

        return {
          stepState: {
            step_id: step.id,
            status: "completed",
            output: toolResult.output,
            completed_at: new Date().toISOString(),
            latency_ms: latencyMs,
            attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
          },
          timedOut,
          compensation: toolResult.compensation,
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
            const retryResult = await toolExecutor.execute(
              step.tool_name,
              recoveryResult.correctedParameters,
              step.timeout_ms
            );

            if (retryResult.success) {
              await RealtimeService.publishStreamingStatusUpdate({
                executionId: state.execution_id,
                stepIndex,
                totalSteps,
                stepName: step.tool_name,
                status: 'completed',
                message: `Completed ${step.description || step.tool_name} (after retry)`,
                timestamp: new Date().toISOString(),
                traceId: traceId,
              });

              return {
                stepState: {
                  step_id: step.id,
                  status: "completed",
                  output: retryResult.output,
                  completed_at: new Date().toISOString(),
                  latency_ms: latencyMs,
                  attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
                },
                timedOut,
                compensation: retryResult.compensation,
              };
            }
          }
        }

        await RealtimeService.publishStreamingStatusUpdate({
          executionId: state.execution_id,
          stepIndex,
          totalSteps,
          stepName: step.tool_name,
          status: 'failed',
          message: `Failed: ${typeof toolResult.error === 'string' ? toolResult.error : 'Unknown error'}`,
          timestamp: new Date().toISOString(),
          traceId: traceId,
        });

        const isValidationError = toolResult.error?.toLowerCase().includes("invalid parameters");
        return {
          stepState: {
            step_id: step.id,
            status: "failed",
            error: {
              code: isValidationError ? "TOOL_VALIDATION_FAILED" : "TOOL_EXECUTION_FAILED",
              message: toolResult.error || "Unknown tool execution error",
              httpCode: errorCode,
            },
            completed_at: new Date().toISOString(),
            latency_ms: latencyMs,
            attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
          },
          timedOut,
        };
      }
    } catch (error) {
      const stepEndTime = performance.now();
      const latencyMs = Math.round(stepEndTime - stepStartTime);
      const elapsedInSegment = Date.now() - segmentStartTime;

      const errorMessage = error instanceof Error ? error.message : String(error);
      const timedOut = elapsedInSegment >= CHECKPOINT_THRESHOLD_MS || 
                       errorMessage.includes('AbortError') ||
                       errorMessage.includes('cancelled');

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

      await RealtimeService.publishStreamingStatusUpdate({
        executionId: state.execution_id,
        stepIndex,
        totalSteps,
        stepName: step.tool_name,
        status: 'failed',
        message: `Error: ${errorMessage}`,
        timestamp: new Date().toISOString(),
        traceId: traceId,
      });

      return {
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
        timedOut,
      };
    }
  });
}

// ============================================================================
// PARAMETER RESOLUTION
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
// FIND READY STEPS
// Find pending steps whose dependencies are satisfied
// ============================================================================

function findReadySteps(plan: Plan, state: ExecutionState, startIndex: number = 0): PlanStep[] {
  const pendingSteps = getPendingSteps(state).filter(s => {
    const step = plan.steps.find(ps => ps.id === s.step_id);
    return step && plan.steps.indexOf(step) >= startIndex;
  });
  
  const readySteps: PlanStep[] = [];

  for (const pendingStep of pendingSteps) {
    const planStep = plan.steps.find((s) => s.id === pendingStep.step_id);
    if (planStep && isStepReady(planStep, state)) {
      readySteps.push(planStep);
    }
  }

  return readySteps;
}

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
// EXECUTE SEGMENT
// Execute steps until timeout threshold or all steps complete
// Vercel Hobby Tier Optimization: Task Queue state machine
// ============================================================================

export async function executeSegment(
  plan: Plan,
  toolExecutor: ToolExecutor,
  options: {
    executionId: string;
    initialState?: ExecutionState;
    traceCallback?: (entry: TraceEntry) => void;
    idempotencyService?: IdempotencyService;
    startStepIndex?: number;
    segmentNumber?: number;
    traceId?: string;
  }
): Promise<DurableExecutionResult> {
  const startTime = performance.now();
  const segmentStartTime = Date.now();
  const executionId = options.executionId;
  const startStepIndex = options.startStepIndex || 0;
  const segmentNumber = options.segmentNumber || 1;
  const traceId = options.traceId;
  const memory = getSharedMemoryClient()!;

  // Initialize TaskState if not exists
  const existingTaskState = await memory.getTaskState(executionId);
  
  if (!existingTaskState) {
    // Create new TaskState
    const initialTaskState: TaskState = {
      task_id: executionId,
      execution_id: executionId,
      intent_id: options.initialState?.intent?.id,
      status: "pending",
      current_step_index: startStepIndex,
      total_steps: plan.steps.length,
      segment_number: segmentNumber,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      transitions: [{
        from_status: "pending",
        to_status: "pending",
        timestamp: new Date().toISOString(),
        reason: "EXECUTION_STARTED",
      }],
      context: {
        priority: segmentNumber,
      },
    };
    await memory.createTaskState(initialTaskState);
  }

  // Transition to in_progress
  await memory.transitionTaskState(executionId, "in_progress", `Segment ${segmentNumber} starting`);

  // Load or create initial execution state
  let state: ExecutionState;
  if (options.initialState) {
    state = options.initialState;
  } else {
    const existingState = await loadExecutionState(executionId);
    if (existingState) {
      console.log(`[DurableExecution] Resuming execution ${executionId} from checkpoint`);
      state = existingState;
    } else {
      state = createInitialState(executionId);
      state = applyStateUpdate(state, { plan, status: "PLANNED" });
    }
  }

  try {
    state = transitionState(state, "EXECUTING");
  } catch (error) {
    throw new Error(`State transition failed: ${error instanceof Error ? error.message : "Unknown"}`);
  }

  state = applyStateUpdate(state, { status: "EXECUTING" });

  // Initialize step states for new steps
  for (const step of plan.steps) {
    if (!getStepState(state, step.id)) {
      state = updateStepState(state, step.id, { status: "pending" });
    }
  }

  await saveExecutionState(state);

  let currentStepIndex = startStepIndex;
  let completedInSegment = 0;

  try {
    while (true) {
      // Check timeout threshold
      const elapsedInSegment = Date.now() - segmentStartTime;
      if (elapsedInSegment >= CHECKPOINT_THRESHOLD_MS) {
        console.log(
          `[DurableExecution] Approaching timeout at ${elapsedInSegment}ms, ` +
          `creating checkpoint after ${completedInSegment} steps`
        );

        // Save checkpoint using Task Queue pattern
        const checkpoint: ExecutionCheckpoint = {
          executionId,
          intentId: state.intent?.id,
          planId: plan.id,
          state,
          nextStepIndex: currentStepIndex,
          completedInSegment,
          segmentNumber: segmentNumber + 1,
          checkpointAt: new Date().toISOString(),
          traceId,
          reason: "TIMEOUT_APPROACHING",
        };

        await CheckpointManager.saveCheckpoint(checkpoint);
        await CheckpointManager.scheduleResume(executionId, checkpoint);
        await CheckpointManager.publishContinuationEvent(executionId, checkpoint);

        return {
          state,
          success: false,
          completed_steps: getCompletedSteps(state).length,
          failed_steps: state.step_states.filter(s => s.status === "failed").length,
          total_steps: plan.steps.length,
          execution_time_ms: Math.round(Date.now() - startTime),
          isPartial: true,
          checkpointCreated: true,
          nextStepIndex: currentStepIndex,
          segmentNumber,
          continuationEventPublished: true,
        };
      }

      // Find ready steps from current index
      const readySteps = findReadySteps(plan, state, currentStepIndex);

      if (readySteps.length === 0) {
        const completedCount = getCompletedSteps(state).length;
        const failedCount = state.step_states.filter(s => s.status === "failed").length;
        const totalCount = plan.steps.length;

        if (completedCount + failedCount === totalCount) {
          // All steps completed
          break;
        } else {
          throw new Error(
            `Execution deadlock: ${totalCount - completedCount - failedCount} pending steps, none ready`
          );
        }
      }

      // Execute ready steps in parallel
      const stepIds = readySteps.map(s => s.id);
      const stepResultsSettled = await Promise.allSettled(
        readySteps.map((step) =>
          executeStepWithCheckpointing({
            state,
            step,
            toolExecutor,
            traceCallback: options.traceCallback,
            idempotencyService: options.idempotencyService,
            segmentStartTime,
            traceId,
          })
        )
      );

      // Log all execution results (no floating promises)
      // Extract step states for logging compatibility
      const stepStates = stepResultsSettled.map(result => {
        if (result.status === "fulfilled") {
          return { value: result.value.stepState };
        }
        return result;
      });
      logExecutionResults(stepIds, stepStates as any, "SEGMENT_EXECUTION");

      let anyFailed = false;
      let maxStepIndex = currentStepIndex;

      for (let i = 0; i < stepResultsSettled.length; i++) {
        const settledResult = stepResultsSettled[i];
        const step = readySteps[i];
        const stepIndex = plan.steps.findIndex(s => s.id === step.id);
        
        if (stepIndex > maxStepIndex) {
          maxStepIndex = stepIndex;
        }

        if (settledResult.status === "fulfilled") {
          const { stepState, compensation } = settledResult.value;
          state = updateStepState(state, step.id, stepState);
          
          // Store compensation for saga
          if (compensation) {
            state.context = {
              ...state.context,
              [`compensation:${step.id}`]: compensation,
            };
          }

          if (stepState.status === "completed") {
            completedInSegment++;
          } else if (stepState.status === "failed") {
            anyFailed = true;
          }
        } else {
          anyFailed = true;
          const errorResult: StepExecutionState = {
            step_id: step.id,
            status: "failed",
            error: {
              code: "UNKNOWN_ERROR",
              message: String(settledResult.reason),
            },
            completed_at: new Date().toISOString(),
            attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
          };
          state = updateStepState(state, step.id, errorResult);
        }
      }

      await saveExecutionState(state);
      currentStepIndex = maxStepIndex + 1;

      if (anyFailed) {
        // Handle failure - transition TaskState to failed
        await memory.transitionTaskState(executionId, "failed", "Step execution failed");
        
        state = applyStateUpdate(state, { status: "REFLECTING" });
        await saveExecutionState(state);

        return {
          state,
          success: false,
          completed_steps: getCompletedSteps(state).length,
          failed_steps: state.step_states.filter(s => s.status === "failed").length,
          total_steps: plan.steps.length,
          execution_time_ms: Math.round(Date.now() - startTime),
          isPartial: false,
          error: {
            code: "STEP_FAILED",
            message: "One or more steps failed",
          },
        };
      }
    }

    // All steps completed successfully
    const endTime = performance.now();
    state = applyStateUpdate(state, {
      status: "COMPLETED",
      completed_at: new Date().toISOString(),
    });

    await saveExecutionState(state);
    await CheckpointManager.deleteCheckpoint(executionId);
    
    // Transition TaskState to completed
    await memory.transitionTaskState(executionId, "completed", "All steps completed successfully");

    return {
      state,
      success: true,
      completed_steps: plan.steps.length,
      failed_steps: 0,
      total_steps: plan.steps.length,
      execution_time_ms: Math.round(endTime - startTime),
      isPartial: false,
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

    await saveExecutionState(state);
    
    // Transition TaskState to failed
    await memory.transitionTaskState(executionId, "failed", `Execution error: ${errorMessage}`);

    return {
      state,
      success: false,
      completed_steps: getCompletedSteps(state).length,
      failed_steps: state.step_states.filter(s => s.status === "failed").length,
      total_steps: plan.steps.length,
      execution_time_ms: Math.round(endTime - startTime),
      isPartial: false,
      error: {
        code: "EXECUTION_FAILED",
        message: errorMessage,
      },
    };
  }
}

// ============================================================================
// RESUME FROM CHECKPOINT
// Entry point for /api/mesh/resume
// ============================================================================

export async function resumeFromCheckpoint(
  executionId: string,
  toolExecutor: ToolExecutor,
  options: {
    traceCallback?: (entry: TraceEntry) => void;
    idempotencyService?: IdempotencyService;
    traceId?: string;
  } = {}
): Promise<DurableExecutionResult> {
  const checkpoint = await CheckpointManager.loadCheckpoint(executionId);
  
  if (!checkpoint) {
    throw new Error(`No checkpoint found for execution ${executionId}`);
  }

  console.log(
    `[DurableExecution] Resuming ${executionId} from checkpoint ` +
    `[segment ${checkpoint.segmentNumber}, step ${checkpoint.nextStepIndex}]`
  );

  return executeSegment(
    checkpoint.state.plan!,
    toolExecutor,
    {
      executionId,
      initialState: checkpoint.state,
      traceCallback: options.traceCallback,
      idempotencyService: options.idempotencyService,
      startStepIndex: checkpoint.nextStepIndex,
      segmentNumber: checkpoint.segmentNumber,
      traceId: options.traceId || checkpoint.traceId,
    }
  );
}
