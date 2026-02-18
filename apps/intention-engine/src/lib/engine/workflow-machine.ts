/**
 * WorkflowMachine - Unified Durable Workflow Engine
 *
 * Consolidates orchestrator.ts, durable-execution.ts, saga.ts, and step-transaction.ts
 * into a single state machine runner optimized for Vercel Hobby Tier (10s timeout).
 *
 * Key Features:
 * 1. Yield-and-Resume Pattern: Checkpoints state to Redis when approaching timeout
 * 2. Saga Pattern: Automatic compensation for failed state-modifying operations
 * 3. Deterministic Verification: Non-LLM validation against DB_REFLECTED_SCHEMAS
 * 4. Distributed Tracing: Correlation IDs propagated across all steps
 *
 * Architecture:
 * - Every step checks performance.now() against CHECKPOINT_THRESHOLD_MS
 * - If elapsed > 7500ms, atomically saves state to Redis and yields
 * - Emits WORKFLOW_RESUME event via Ably for continuation
 * - On resume, loads state from Redis and continues from next step
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
  getFailedSteps,
} from "./state-machine";
import { saveExecutionState, loadExecutionState, getMemoryClient } from "./memory";
import { RealtimeService, MemoryClient, getMemoryClient as getSharedMemoryClient } from "@repo/shared";
import { getAblyClient, TaskState, TaskStatus } from "@repo/shared";
import { Tracer } from "./tracing";
import { getToolRegistry } from "./tools/registry";
import { IdempotencyService } from "@repo/shared";
import {
  validateBeforeExecution,
  extractErrorCode,
  isClientOrServerError,
  attemptErrorRecovery,
} from "./execution-helpers";
import {
  COMPENSATIONS,
  needsCompensation,
  getCompensation,
  mapCompensationParameters,
  IDEMPOTENT_TOOLS,
} from "@repo/mcp-protocol";
import { DB_REFLECTED_SCHEMAS } from "@repo/mcp-protocol";
import { NormalizationService } from "@repo/shared";
import { verifyPlan, DEFAULT_SAFETY_POLICY, SafetyPolicy } from "./verifier";

// ============================================================================
// CONFIGURATION
// Vercel Hobby Tier Optimization
// ============================================================================

const VERCEL_TIMEOUT_MS = 10000; // Vercel kills lambdas at 10s
const CHECKPOINT_THRESHOLD_MS = 7500; // Save state at 7.5s to allow 2.5s buffer
const SEGMENT_TIMEOUT_MS = 8500; // Abort individual steps at 8.5s
const SAGA_TIMEOUT_MS = 120000; // 2 minutes for entire saga

// ============================================================================
// WORKFLOW STATUS ENUM
// Extended execution status with saga-specific states
// ============================================================================

export enum WorkflowStatus {
  CREATED = "CREATED",
  VALIDATING = "VALIDATING",
  VALIDATED = "VALIDATED",
  PLANNED = "PLANNED",
  EXECUTING = "EXECUTING",
  YIELDING = "YIELDING", // Approaching timeout, checkpointing
  AWAITING_CONFIRMATION = "AWAITING_CONFIRMATION",
  COMPENSATING = "COMPENSATING",
  COMPENSATED = "COMPENSATED",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  TIMEOUT = "TIMEOUT",
  CANCELLED = "CANCELLED",
}

// ============================================================================
// WORKFLOW CHECKPOINT
// Persisted state for yield-and-resume
// ============================================================================

export interface WorkflowCheckpoint {
  executionId: string;
  intentId?: string;
  planId?: string;
  workflowId: string;
  // Current execution state
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
  // Correlation ID for linking related events
  correlationId?: string;
  // Reason for checkpoint
  reason: "TIMEOUT_APPROACHING" | "SEGMENT_COMPLETE" | "ERROR_RECOVERY" | "COMPENSATION";
  // Saga context if applicable
  sagaContext?: {
    sagaId: string;
    compensationsRegistered: Array<{
      stepId: string;
      compensationTool: string;
      parameters: Record<string, unknown>;
    }>;
  };
}

// ============================================================================
// WORKFLOW RESULT
// Result of workflow execution
// ============================================================================

export interface WorkflowResult {
  workflowId: string;
  state: ExecutionState;
  success: boolean;
  completedSteps: number;
  failedSteps: number;
  totalSteps: number;
  executionTimeMs: number;
  // Segmentation info
  isPartial: boolean;
  checkpointCreated?: boolean;
  nextStepIndex?: number;
  segmentNumber?: number;
  continuationEventPublished?: boolean;
  // Saga info
  wasCompensated?: boolean;
  compensatedSteps?: number;
  // Summary
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
    stepId?: string;
    stepToolName?: string;
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
  segmentStartTime: number;
  traceId?: string;
  correlationId?: string;
  idempotencyService?: IdempotencyService;
}

// ============================================================================
// WORKFLOW MACHINE CLASS
// Main state machine runner
// ============================================================================

export class WorkflowMachine {
  private workflowId: string;
  private executionId: string;
  private intentId?: string;
  private plan?: Plan;
  private state: ExecutionState;
  private toolExecutor: ToolExecutor;
  private memoryClient: MemoryClient;
  private segmentStartTime: number = 0;
  private segmentNumber: number = 1;
  private traceId?: string;
  private correlationId: string;
  private idempotencyService?: IdempotencyService;
  private safetyPolicy: SafetyPolicy;
  private compensationsRegistered: Array<{
    stepId: string;
    compensationTool: string;
    parameters: Record<string, unknown>;
  }> = [];

  constructor(
    executionId: string,
    toolExecutor: ToolExecutor,
    options?: {
      workflowId?: string;
      intentId?: string;
      initialState?: ExecutionState;
      traceId?: string;
      correlationId?: string;
      idempotencyService?: IdempotencyService;
      safetyPolicy?: SafetyPolicy;
    }
  ) {
    this.executionId = executionId;
    this.workflowId = options?.workflowId || `workflow:${executionId}`;
    this.intentId = options?.intentId;
    this.toolExecutor = toolExecutor;
    this.memoryClient = getSharedMemoryClient()!;
    this.traceId = options?.traceId;
    this.correlationId = options?.correlationId || crypto.randomUUID();
    this.idempotencyService = options?.idempotencyService;
    this.safetyPolicy = options?.safetyPolicy || DEFAULT_SAFETY_POLICY;

    // Initialize or load state
    if (options?.initialState) {
      this.state = options.initialState;
    } else {
      this.state = createInitialState(executionId);
    }
  }

  /**
   * Set the plan for execution
   */
  setPlan(plan: Plan): void {
    this.plan = plan;
    this.state = applyStateUpdate(this.state, { plan });
    this.state = transitionState(this.state, "PLANNED");
  }

  /**
   * Get current workflow status
   */
  getStatus(): WorkflowStatus {
    const status = this.state.status;
    switch (status) {
      case "EXECUTING":
        return WorkflowStatus.EXECUTING;
      case "AWAITING_CONFIRMATION":
        return WorkflowStatus.AWAITING_CONFIRMATION;
      case "COMPLETED":
        return WorkflowStatus.COMPLETED;
      case "FAILED":
        return WorkflowStatus.FAILED;
      case "TIMEOUT":
        return WorkflowStatus.TIMEOUT;
      case "CANCELLED":
        return WorkflowStatus.CANCELLED;
      default:
        return WorkflowStatus.CREATED;
    }
  }

  /**
   * Get current execution state
   */
  getState(): ExecutionState {
    return this.state;
  }

  /**
   * Verify plan against safety policy before execution
   */
  async verifyPlan(): Promise<{ valid: boolean; reason?: string }> {
    if (!this.plan) {
      return { valid: false, reason: "No plan set" };
    }

    // Note: We can't transition to VALIDATING as it's not in the ExecutionStatus enum
    // Instead, we just perform the validation directly

    try {
      // Step 1: Verify against safety policy
      const verification = verifyPlan(this.plan, this.safetyPolicy);
      if (!verification.valid) {
        return { valid: false, reason: verification.reason };
      }

      // Step 2: Validate each step's parameters against DB_REFLECTED_SCHEMAS
      for (const step of this.plan.steps) {
        const validationResult = NormalizationService.validateToolParameters(
          step.tool_name,
          step.parameters
        );

        if (!validationResult.success) {
          const errorMessages = validationResult.errors
            .map(e => `${e.path}: ${e.message}`)
            .join("; ");
          return {
            valid: false,
            reason: `Step ${step.id} (${step.tool_name}) parameter validation failed: ${errorMessages}`,
          };
        }
      }

      return { valid: true };
    } catch (error) {
      return {
        valid: false,
        reason: error instanceof Error ? error.message : "Verification failed",
      };
    }
  }

  /**
   * Execute the workflow with yield-and-resume pattern
   */
  async execute(): Promise<WorkflowResult> {
    const startTime = performance.now();
    this.segmentStartTime = Date.now();

    return Tracer.startActiveSpan("workflow_execution", async (span) => {
      this.traceId = span.spanContext()?.traceId;

      span.setAttributes({
        workflow_id: this.workflowId,
        execution_id: this.executionId,
        intent_id: this.intentId,
        trace_id: this.traceId,
        correlation_id: this.correlationId,
      });

      try {
        // Verify plan before execution
        if (this.plan) {
          const verification = await this.verifyPlan();
          if (!verification.valid) {
            throw EngineErrorSchema.parse({
              code: "PLAN_VALIDATION_FAILED",
              message: verification.reason,
              recoverable: false,
              timestamp: new Date().toISOString(),
            });
          }
        }

        this.state = transitionState(this.state, "EXECUTING");

        // Main execution loop
        while (true) {
          // Check if we're approaching timeout
          const elapsedInSegment = Date.now() - this.segmentStartTime;
          if (elapsedInSegment >= CHECKPOINT_THRESHOLD_MS) {
            console.log(
              `[WorkflowMachine] Approaching timeout (${elapsedInSegment}ms), yielding...`
            );
            return await this.yieldExecution("TIMEOUT_APPROACHING");
          }

          // Find ready steps
          const readySteps = this.findReadySteps();

          if (readySteps.length === 0) {
            // Check if all steps are complete
            const completedCount = getCompletedSteps(this.state).length;
            const failedCount = getFailedSteps(this.state).length;
            const totalCount = this.plan?.steps.length || 0;

            if (completedCount + failedCount === totalCount) {
              // Check if any steps failed
              if (failedCount > 0) {
                // Trigger compensation if this is a saga
                const hasCompensatableSteps = this.plan?.steps.some(step =>
                  needsCompensation(step.tool_name)
                );

                if (hasCompensatableSteps) {
                  return await this.executeCompensation();
                }

                return this.createResult(false, startTime, "Steps failed");
              }

              // All steps completed successfully
              return this.createResult(true, startTime, "Workflow completed successfully");
            } else {
              // Deadlock detected
              throw EngineErrorSchema.parse({
                code: "PLAN_CIRCULAR_DEPENDENCY",
                message: "Execution deadlock detected: pending steps exist but none are ready",
                recoverable: false,
                timestamp: new Date().toISOString(),
              });
            }
          }

          // Execute ready steps in parallel
          const stepIds = readySteps.map(s => s.id);
          const stepResultsSettled = await Promise.allSettled(
            readySteps.map((step) =>
              this.executeStep({
                state: this.state,
                step,
                toolExecutor: this.toolExecutor,
                segmentStartTime: this.segmentStartTime,
                traceId: this.traceId,
                correlationId: this.correlationId,
                idempotencyService: this.idempotencyService,
              })
            )
          );

          // Log execution results
          for (let i = 0; i < stepResultsSettled.length; i++) {
            const result = stepResultsSettled[i];
            const stepId = stepIds[i];

            if (result.status === "fulfilled") {
              const stepResult = result.value;
              this.state = updateStepState(this.state, stepId, stepResult.stepState);

              // Register compensation if provided
              if (stepResult.compensation) {
                this.compensationsRegistered.push({
                  stepId,
                  compensationTool: stepResult.compensation.toolName,
                  parameters: stepResult.compensation.parameters || {},
                });
              }

              console.log(
                `[WorkflowMachine] Step ${stepId} (${readySteps[i].tool_name}) completed: ${stepResult.stepState.status}`
              );
            } else {
              console.error(
                `[WorkflowMachine] Step ${stepId} failed with exception:`,
                result.reason
              );
            }
          }

          // Check if any step failed and needs compensation
          const failedStep = readySteps.find((step, i) => {
            const result = stepResultsSettled[i];
            return result.status === "fulfilled" && result.value.stepState.status === "failed";
          });

          if (failedStep) {
            const failedStepState = getStepState(this.state, failedStep.id);
            if (failedStepState?.status === "failed") {
              // Check if this step needs compensation
              if (needsCompensation(failedStep.tool_name)) {
                return await this.executeCompensation();
              }

              // Non-compensatable failure
              return this.createResult(false, startTime, `Step ${failedStep.id} failed`);
            }
          }

          // Check if we need to yield after this batch
          const elapsedAfterBatch = Date.now() - this.segmentStartTime;
          if (elapsedAfterBatch >= CHECKPOINT_THRESHOLD_MS) {
            return await this.yieldExecution("TIMEOUT_APPROACHING");
          }
        }
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));

        this.state = setExecutionError(
          this.state,
          error instanceof Error ? error.message : String(error),
          this.traceId
        );

        return this.createResult(false, startTime, error instanceof Error ? error.message : String(error));
      }
    });
  }

  /**
   * Execute a single step - Serverless Recursive Pattern
   * 
   * Vercel Hobby Tier Optimization:
   * - Executes ONE step and returns immediately
   * - Does NOT loop or recurse internally
   * - Caller is responsible for triggering next step via recursive fetch
   * - Used by /api/engine/execute-step for infinite-duration sagas
   * 
   * @param stepIndex - Optional index of step to execute (defaults to next pending)
   * @returns Result of single step execution
   */
  async executeSingleStep(stepIndex?: number): Promise<{
    success: boolean;
    stepId?: string;
    stepToolName?: string;
    stepState: StepExecutionState;
    compensation?: {
      toolName: string;
      parameters?: Record<string, unknown>;
    };
    isComplete: boolean;
    completedSteps: number;
    totalSteps: number;
  }> {
    if (!this.plan) {
      throw new Error("No plan set");
    }

    const timestamp = new Date().toISOString();

    // Find the step to execute
    const completedStepIds = getCompletedSteps(this.state).map(s => s.step_id);
    const targetStep = this.plan.steps.find((step, idx) => 
      idx >= (stepIndex || 0) && !completedStepIds.includes(step.id)
    );

    if (!targetStep) {
      // No more steps - execution complete
      return {
        success: true,
        isComplete: true,
        completedSteps: getCompletedSteps(this.state).length,
        totalSteps: this.plan.steps.length,
        stepState: {
          step_id: "complete",
          status: "completed",
          output: { message: "All steps completed" },
          completed_at: timestamp,
          latency_ms: 0,
          attempts: 0,
        },
      };
    }

    const actualStepIndex = this.plan.steps.indexOf(targetStep);

    // Execute the step using existing executeStep logic
    const result = await this.executeStep({
      state: this.state,
      step: targetStep,
      toolExecutor: this.toolExecutor,
      segmentStartTime: this.segmentStartTime,
      traceId: this.traceId,
      correlationId: this.correlationId,
      idempotencyService: this.idempotencyService,
    });

    // Update state
    this.state = updateStepState(this.state, targetStep.id, result.stepState);

    // Register compensation if provided
    if (result.compensation) {
      this.compensationsRegistered.push({
        stepId: targetStep.id,
        compensationTool: result.compensation.toolName,
        parameters: result.compensation.parameters || {},
      });
    }

    const completedCount = getCompletedSteps(this.state).length;
    const isComplete = completedCount === this.plan.steps.length;

    return {
      success: result.stepState.status === "completed",
      stepId: targetStep.id,
      stepToolName: targetStep.tool_name,
      stepState: result.stepState,
      compensation: result.compensation,
      isComplete,
      completedSteps: completedCount,
      totalSteps: this.plan.steps.length,
    };
  }

  /**
   * Execute a single step with checkpointing
   */
  private async executeStep(
    context: StepExecutionContext
  ): Promise<{
    stepState: StepExecutionState;
    compensation?: {
      toolName: string;
      parameters?: Record<string, unknown>;
    };
  }> {
    const { state, step, toolExecutor, segmentStartTime, traceId, correlationId, idempotencyService } = context;
    const stepStartTime = performance.now();
    const timestamp = new Date().toISOString();
    const stepIndex = state.step_states.findIndex(s => s.step_id === step.id) ?? 0;
    const totalSteps = state.step_states.length;

    return await Tracer.startActiveSpan(`execute_step:${step.tool_name}`, async (span) => {
      const toolDef = getToolRegistry().getDefinition(step.tool_name);
      span.setAttributes({
        intent_id: this.intentId || "unknown",
        step_type: step.tool_name,
        mcp_server_origin: toolDef?.origin || "local",
        trace_id: traceId || "unknown",
        correlation_id: correlationId,
      });

      try {
        // IDEMPOTENCY CHECK
        const idempotencyKey = `${this.intentId || this.executionId}:${stepIndex}`;
        if (idempotencyService) {
          const isDuplicate = await idempotencyService.isDuplicate(idempotencyKey);
          if (isDuplicate) {
            console.log(`[Idempotency] Step ${step.tool_name} (${step.id}) already executed, skipping`);
            span.setAttributes({ idempotency_skip: true });

            await RealtimeService.publishStreamingStatusUpdate({
              executionId: this.executionId,
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
            };
          }
        }

        let stepState = updateStepState(state, step.id, {
          status: "in_progress",
          started_at: timestamp,
          attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
        });

        // Resolve parameter references
        const resolvedParameters = this.resolveStepParameters(step, stepState);

        // Dynamic Parameter Bridge
        if (toolDef?.parameter_aliases) {
          for (const [alias, primary] of Object.entries(toolDef.parameter_aliases)) {
            if (resolvedParameters[alias] !== undefined && resolvedParameters[primary] === undefined) {
              resolvedParameters[primary] = resolvedParameters[alias];
            }
          }
        }

        // Validation before execution using DB_REFLECTED_SCHEMAS
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
          };
        }

        // PRE-EMPTIVE CHECKPOINTING - Save before tool call
        stepState = updateStepState(stepState, step.id, {
          input: resolvedParameters,
        });
        await saveExecutionState(stepState);

        // STREAMING STATUS UPDATE - Step Start
        await RealtimeService.publishStreamingStatusUpdate({
          executionId: this.executionId,
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
            `[WorkflowMachine] Step ${step.tool_name} approaching Vercel timeout, aborting...`
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

        if (toolResult.success) {
          await RealtimeService.publishStreamingStatusUpdate({
            executionId: this.executionId,
            stepIndex,
            totalSteps,
            stepName: step.tool_name,
            status: 'completed',
            message: `Completed ${step.description || step.tool_name}`,
            timestamp: new Date().toISOString(),
            traceId: traceId,
          });

          // AUTO-REGISTER COMPENSATION
          let compensation: { toolName: string; parameters?: Record<string, unknown> } | undefined;
          if (!compensation && needsCompensation(step.tool_name)) {
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
                `[WorkflowMachine] Registered compensation for ${step.tool_name}: ${compDef.toolName}`
              );
            }
          }

          return {
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
              const retryResult = await toolExecutor.execute(
                step.tool_name,
                recoveryResult.correctedParameters,
                step.timeout_ms
              );

              if (retryResult.success) {
                await RealtimeService.publishStreamingStatusUpdate({
                  executionId: this.executionId,
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
                };
              }
            }
          }

          await RealtimeService.publishStreamingStatusUpdate({
            executionId: this.executionId,
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
          };
        }
      } catch (error) {
        const stepEndTime = performance.now();
        const latencyMs = Math.round(stepEndTime - stepStartTime);

        const errorMessage = error instanceof Error ? error.message : String(error);

        await RealtimeService.publishStreamingStatusUpdate({
          executionId: this.executionId,
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
        };
      }
    });
  }

  /**
   * Find steps that are ready to execute (dependencies satisfied)
   */
  private findReadySteps(): PlanStep[] {
    if (!this.plan) return [];

    const pendingSteps = getPendingSteps(this.state);
    const readySteps: PlanStep[] = [];

    for (const pendingStep of pendingSteps) {
      const planStep = this.plan.steps.find((s) => s.id === pendingStep.step_id);
      if (planStep && this.isStepReady(planStep)) {
        readySteps.push(planStep);
      }
    }

    return readySteps;
  }

  /**
   * Check if a step's dependencies are satisfied
   */
  private isStepReady(step: PlanStep): boolean {
    if (step.dependencies.length === 0) {
      return true;
    }

    for (const depId of step.dependencies) {
      const depState = getStepState(this.state, depId);
      if (!depState || depState.status !== "completed") {
        return false;
      }
    }

    return true;
  }

  /**
   * Resolve parameter references in step parameters
   */
  private resolveStepParameters(
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

  /**
   * Yield execution and save checkpoint
   */
  private async yieldExecution(reason: WorkflowCheckpoint["reason"]): Promise<WorkflowResult> {
    const nextStepIndex = this.getNextStepIndex();

    const checkpoint: WorkflowCheckpoint = {
      executionId: this.executionId,
      intentId: this.intentId,
      planId: this.plan?.id,
      workflowId: this.workflowId,
      state: this.state,
      nextStepIndex,
      completedInSegment: 0,
      segmentNumber: this.segmentNumber,
      checkpointAt: new Date().toISOString(),
      traceId: this.traceId,
      correlationId: this.correlationId,
      reason,
      sagaContext: this.compensationsRegistered.length > 0 ? {
        sagaId: `saga:${this.executionId}`,
        compensationsRegistered: this.compensationsRegistered,
      } : undefined,
    };

    // Save checkpoint to Redis
    await this.saveCheckpoint(checkpoint);

    // Schedule resume via Ably
    await this.scheduleResume(checkpoint);

    // Keep state as EXECUTING since we'll resume
    // Note: Can't use "YIELDING" as it's not in the ExecutionStatus enum

    return {
      workflowId: this.workflowId,
      state: this.state,
      success: false,
      completedSteps: getCompletedSteps(this.state).length,
      failedSteps: getFailedSteps(this.state).length,
      totalSteps: this.plan?.steps.length || 0,
      executionTimeMs: 0, // Will be calculated on resume
      isPartial: true,
      checkpointCreated: true,
      nextStepIndex,
      segmentNumber: this.segmentNumber,
      continuationEventPublished: true,
    };
  }

  /**
   * Execute compensation for failed saga
   */
  private async executeCompensation(): Promise<WorkflowResult> {
    console.log(
      `[WorkflowMachine] Executing compensation for workflow ${this.workflowId}`
    );

    // Note: Can't transition to "COMPENSATING" as it's not in the ExecutionStatus enum
    // We'll just execute the compensation directly

    let compensated = 0;
    let failed = 0;

    // Execute compensations in reverse order
    for (let i = this.compensationsRegistered.length - 1; i >= 0; i--) {
      const comp = this.compensationsRegistered[i];
      const stepState = getStepState(this.state, comp.stepId);

      if (!stepState || stepState.status !== "completed") {
        continue; // Only compensate completed steps
      }

      try {
        const result = await this.toolExecutor.execute(
          comp.compensationTool,
          comp.parameters,
          30000
        );

        if (result.success) {
          compensated++;
          console.log(
            `[WorkflowMachine] Compensation successful for step ${comp.stepId}: ${comp.compensationTool}`
          );
        } else {
          failed++;
          console.error(
            `[WorkflowMachine] Compensation failed for step ${comp.stepId}: ${result.error}`
          );
        }
      } catch (error) {
        failed++;
        console.error(
          `[WorkflowMachine] Compensation error for step ${comp.stepId}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    if (failed === 0) {
      // Mark as compensated - use FAILED status with context
      this.state = applyStateUpdate(this.state, {
        status: "FAILED",
        context: {
          ...this.state.context,
          compensationStatus: "COMPENSATED",
          compensatedSteps: compensated,
        },
      });
    } else {
      this.state = setExecutionError(
        this.state,
        `${failed} compensations failed`
      );
    }

    // Publish compensation event
    await RealtimeService.publishNervousSystemEvent(
      "SagaCompensated",
      {
        workflowId: this.workflowId,
        executionId: this.executionId,
        compensated,
        failed,
        totalCompensations: this.compensationsRegistered.length,
        timestamp: new Date().toISOString(),
      },
      this.traceId
    );

    return this.createResult(false, performance.now(), `Compensated ${compensated} steps, ${failed} failed`);
  }

  /**
   * Save checkpoint to Redis
   */
  private async saveCheckpoint(checkpoint: WorkflowCheckpoint): Promise<void> {
    try {
      await this.memoryClient.updateTaskContext(this.executionId, {
        execution_state: checkpoint.state,
        last_checkpoint_at: checkpoint.checkpointAt,
        segment_number: checkpoint.segmentNumber,
        next_step_index: checkpoint.nextStepIndex,
        workflow_id: this.workflowId,
        compensations_registered: checkpoint.sagaContext?.compensationsRegistered,
      });

      console.log(
        `[WorkflowMachine] Checkpoint saved for ${this.executionId} ` +
        `[segment ${checkpoint.segmentNumber}, next step: ${checkpoint.nextStepIndex}]`
      );
    } catch (error) {
      console.error("[WorkflowMachine] Failed to save checkpoint:", error);
      throw error;
    }
  }

  /**
   * Schedule workflow resume via Ably
   */
  private async scheduleResume(checkpoint: WorkflowCheckpoint): Promise<void> {
    try {
      // Schedule resume in 2 seconds
      await this.memoryClient.scheduleTaskResume(this.executionId, 2, {
        intent_id: this.intentId,
        plan_id: this.plan?.id,
        start_step_index: checkpoint.nextStepIndex,
        segment_number: checkpoint.segmentNumber,
        trace_id: this.traceId,
      });

      // Publish continuation event to Ably
      await RealtimeService.publishNervousSystemEvent(
        "WORKFLOW_RESUME",
        {
          executionId: this.executionId,
          workflowId: this.workflowId,
          intentId: this.intentId,
          planId: this.plan?.id,
          nextStepIndex: checkpoint.nextStepIndex,
          segmentNumber: checkpoint.segmentNumber,
          traceId: this.traceId,
          timestamp: new Date().toISOString(),
        },
        this.traceId
      );

      console.log(
        `[WorkflowMachine] Scheduled resume for ${this.executionId} ` +
        `[segment ${checkpoint.segmentNumber}]`
      );
    } catch (error) {
      console.error("[WorkflowMachine] Failed to schedule resume:", error);
      throw error;
    }
  }

  /**
   * Get next step index to execute
   */
  private getNextStepIndex(): number {
    if (!this.plan) return 0;

    const completedStepIds = new Set(
      getCompletedSteps(this.state).map(s => s.step_id)
    );

    // Find first incomplete step
    for (let i = 0; i < this.plan.steps.length; i++) {
      if (!completedStepIds.has(this.plan.steps[i].id)) {
        return i;
      }
    }

    return this.plan.steps.length;
  }

  /**
   * Create workflow result
   */
  private createResult(
    success: boolean,
    startTime: number,
    summary: string
  ): WorkflowResult {
    const completedSteps = getCompletedSteps(this.state).length;
    const failedSteps = getFailedSteps(this.state).length;

    return {
      workflowId: this.workflowId,
      state: this.state,
      success,
      completedSteps,
      failedSteps,
      totalSteps: this.plan?.steps.length || 0,
      executionTimeMs: Math.round(performance.now() - startTime),
      isPartial: false,
      summary,
      wasCompensated: this.state.context["compensationStatus"] === "COMPENSATED",
      compensatedSteps: this.compensationsRegistered.length,
    };
  }

  /**
   * Resume workflow from checkpoint
   */
  static async resume(
    executionId: string,
    toolExecutor: ToolExecutor,
    options?: {
      traceId?: string;
      correlationId?: string;
    }
  ): Promise<WorkflowResult> {
    const memoryClient = getSharedMemoryClient()!;

    try {
      const taskState = await memoryClient.getTaskState(executionId);
      if (!taskState) {
        throw new Error(`No checkpoint found for execution ${executionId}`);
      }

      const executionState = taskState.context.execution_state as ExecutionState;
      if (!executionState) {
        throw new Error("Invalid execution state in checkpoint");
      }

      console.log(
        `[WorkflowMachine] Resuming execution ${executionId} from checkpoint ` +
        `[segment ${taskState.segment_number}, step ${taskState.current_step_index}]`
      );

      const machine = new WorkflowMachine(executionId, toolExecutor, {
        initialState: executionState,
        intentId: taskState.intent_id,
        traceId: options?.traceId || taskState.context.trace_id as string | undefined,
        correlationId: options?.correlationId,
      });

      // Set plan from state
      if (executionState.plan) {
        machine.setPlan(executionState.plan);
      }

      // Reset segment timer
      machine["segmentNumber"] = (taskState.segment_number || 1) + 1;
      machine["segmentStartTime"] = Date.now();

      return await machine.execute();
    } catch (error) {
      console.error("[WorkflowMachine] Resume failed:", error);
      throw error;
    }
  }
}

/**
 * Set execution error helper
 */
function setExecutionError(
  state: ExecutionState,
  errorMessage: string,
  traceId?: string
): ExecutionState {
  try {
    const failedState = transitionState(state, "FAILED");
    return applyStateUpdate(failedState, {
      error: {
        code: "WORKFLOW_FAILED",
        message: errorMessage,
      },
    });
  } catch (error) {
    // If transition fails, just update error without state change
    return applyStateUpdate(state, {
      error: {
        code: "WORKFLOW_FAILED",
        message: errorMessage,
      },
    });
  }
}

/**
 * Factory function to create and execute workflow
 */
export async function executeWorkflow(
  plan: Plan,
  toolExecutor: ToolExecutor,
  options: {
    executionId?: string;
    intentId?: string;
    traceId?: string;
    correlationId?: string;
    idempotencyService?: IdempotencyService;
    safetyPolicy?: SafetyPolicy;
  } = {}
): Promise<WorkflowResult> {
  const executionId = options.executionId || crypto.randomUUID();

  const machine = new WorkflowMachine(executionId, toolExecutor, {
    intentId: options.intentId,
    traceId: options.traceId,
    correlationId: options.correlationId,
    idempotencyService: options.idempotencyService,
    safetyPolicy: options.safetyPolicy,
  });

  machine.setPlan(plan);
  return await machine.execute();
}
