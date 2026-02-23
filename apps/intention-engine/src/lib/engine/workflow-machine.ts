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
 * - Every step checks performance.now() against CHECKPOINT_THRESHOLD_MS (6000ms)
 * - If elapsed > 6000ms, atomically saves state to Redis and yields
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
import { NormalizationService, createFailoverPolicyEngine, FailoverPolicyEngine } from "@repo/shared";
import { verifyPlan, DEFAULT_SAFETY_POLICY, SafetyPolicy } from "./verifier";
import { redis } from "../redis-client";

// ============================================================================
// LLM CIRCUIT BREAKER CONFIGURATION
// Prevents "LLM Budget Bleed" from recursive correction loops
// ============================================================================

const LLM_CIRCUIT_BREAKER_CONFIG = {
  maxAttempts: 3,              // Max correction attempts before tripping
  windowMs: 60 * 1000,         // 60 second window for attempt counting
  ttlSeconds: 120,             // TTL for circuit breaker keys in Redis
  openTimeoutMs: 5 * 60 * 1000, // 5 minutes before circuit can be tried again
};

// ============================================================================
// CONFIGURATION
// Vercel Hobby Tier Optimization
// ============================================================================

const VERCEL_TIMEOUT_MS = 10000; // Vercel kills lambdas at 10s
const CHECKPOINT_THRESHOLD_MS = 6000; // Save state at 6s to allow 4s buffer (optimized for free tier)
const SEGMENT_TIMEOUT_MS = 8500; // Abort individual steps at 8.5s
const SAGA_TIMEOUT_MS = 120000; // 2 minutes for entire saga

// ============================================================================
// ADAPTIVE BATCHING CONFIGURATION
// Reduces cold start penalties by batching steps intelligently
// ============================================================================

const ADAPTIVE_BATCHING_CONFIG = {
  // Minimum elapsed time before checking if we should yield
  minElapsedBeforeYieldCheck: 4000, // Don't yield before 4s - maximize lambda utilization
  // Estimated average step duration (used for prediction)
  estimatedStepDurationMs: 1500, // Conservative estimate: 1.5s per step
  // Buffer time for state persistence and QStash trigger
  yieldBufferMs: 1500, // Reserve 1.5s for checkpoint + QStash trigger
  // Maximum steps to batch in one segment
  maxBatchSize: 3, // Don't batch more than 3 steps to avoid timeout risk
};

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
  private failoverPolicyEngine: FailoverPolicyEngine;
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
    this.failoverPolicyEngine = createFailoverPolicyEngine();

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
   * FINANCIAL GUARDRAIL - Assert budget safety before LLM calls
   * 
   * Enforces hard USD cost ceiling per execution to prevent runaway token spend.
   * Throws EngineError with BUDGET_EXCEEDED code if limit would be exceeded.
   * 
   * @param estimatedTokens - Estimated tokens for upcoming LLM call
   * @throws EngineError if budget would be exceeded
   */
  private async assertBudgetSafety(estimatedTokens?: number): Promise<void> {
    const budget = this.state.budget;
    
    // Check token limit
    if (estimatedTokens) {
      const projectedTotal = this.state.token_usage.total_tokens + estimatedTokens;
      if (projectedTotal > budget.token_limit) {
        throw EngineErrorSchema.parse({
          code: "BUDGET_EXCEEDED",
          message: `Execution halted: Token limit (${budget.token_limit.toLocaleString()}) would be exceeded.`,
          recoverable: false,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Check USD cost limit
    // Pricing: $0.50 / 1M input tokens, $1.50 / 1M output tokens (GPT-4o-mini approx)
    const INPUT_COST_PER_TOKEN = 0.0000005; // $0.50 per 1M
    const OUTPUT_COST_PER_TOKEN = 0.0000015; // $1.50 per 1M
    
    const estimatedInputCost = (estimatedTokens || 0) * 0.7 * INPUT_COST_PER_TOKEN; // Assume 70% input
    const estimatedOutputCost = (estimatedTokens || 0) * 0.3 * OUTPUT_COST_PER_TOKEN; // Assume 30% output
    const estimatedCost = estimatedInputCost + estimatedOutputCost;
    
    const projectedCost = budget.current_cost_usd + estimatedCost;
    
    if (projectedCost > budget.cost_limit_usd) {
      throw EngineErrorSchema.parse({
        code: "BUDGET_EXCEEDED",
        message: `Execution halted: Cost limit ($${budget.cost_limit_usd.toFixed(2)}) would be exceeded. Current: $${budget.current_cost_usd.toFixed(4)}, Estimated: $${estimatedCost.toFixed(4)}`,
        recoverable: false,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Update budget tracking after LLM call
   */
  private updateBudgetTracking(tokenUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): void {
    const INPUT_COST_PER_TOKEN = 0.0000005;
    const OUTPUT_COST_PER_TOKEN = 0.0000015;
    
    const inputCost = tokenUsage.prompt_tokens * INPUT_COST_PER_TOKEN;
    const outputCost = tokenUsage.completion_tokens * OUTPUT_COST_PER_TOKEN;
    const totalCost = inputCost + outputCost;
    
    this.state = {
      ...this.state,
      token_usage: {
        prompt_tokens: this.state.token_usage.prompt_tokens + tokenUsage.prompt_tokens,
        completion_tokens: this.state.token_usage.completion_tokens + tokenUsage.completion_tokens,
        total_tokens: this.state.token_usage.total_tokens + tokenUsage.total_tokens,
      },
      budget: {
        ...this.state.budget,
        current_cost_usd: this.state.budget.current_cost_usd + totalCost,
      },
    };
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

        // FINANCIAL GUARDRAIL - Check budget before starting execution
        await this.assertBudgetSafety(1000); // Conservative estimate for planning overhead

        this.state = transitionState(this.state, "EXECUTING");

        // Main execution loop with ADAPTIVE BATCHING
        while (true) {
          const elapsedInSegment = Date.now() - this.segmentStartTime;

          // ADAPTIVE BATCHING: Check if we should yield BEFORE executing next batch
          const shouldYield = this.shouldYieldExecution(elapsedInSegment);

          if (shouldYield) {
            console.log(
              `[WorkflowMachine] Adaptive batching: yielding after ${elapsedInSegment}ms (elapsed >= ${ADAPTIVE_BATCHING_CONFIG.minElapsedBeforeYieldCheck}ms)`
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

          // ADAPTIVE BATCHING: Limit batch size to avoid timeout
          const stepsToExecute = readySteps.slice(0, ADAPTIVE_BATCHING_CONFIG.maxBatchSize);

          if (stepsToExecute.length < readySteps.length) {
            console.log(
              `[WorkflowMachine] Adaptive batching: limiting batch to ${stepsToExecute.length}/${readySteps.length} steps`
            );
          }

          // Execute ready steps in parallel
          const stepIds = stepsToExecute.map(s => s.id);
          const stepResultsSettled = await Promise.allSettled(
            stepsToExecute.map((step) =>
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
          const failedStep = stepsToExecute.find((step, i) => {
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

          // ADAPTIVE BATCHING: Check if we need to yield after this batch
          // Use the intelligent shouldYieldExecution method instead of simple threshold
          const elapsedAfterBatch = Date.now() - this.segmentStartTime;
          if (this.shouldYieldExecution(elapsedAfterBatch)) {
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
        let stepState = updateStepState(state, step.id, {
          status: "in_progress",
          started_at: timestamp,
          attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
        });

        // Resolve parameter references BEFORE idempotency check
        const resolvedParameters = this.resolveStepParameters(step, stepState);

        // Dynamic Parameter Bridge
        if (toolDef?.parameter_aliases) {
          for (const [alias, primary] of Object.entries(toolDef.parameter_aliases)) {
            if (resolvedParameters[alias] !== undefined && resolvedParameters[primary] === undefined) {
              resolvedParameters[primary] = resolvedParameters[alias];
            }
          }
        }

        // IDEMPOTENCY CHECK - Enhanced with Semantic Checksum
        // Uses SHA-256(toolName + sortedParameters) for stricter idempotency
        const idempotencyKey = `${this.intentId || this.executionId}:${stepIndex}`;
        if (idempotencyService) {
          const isDuplicate = await idempotencyService.isDuplicate(
            idempotencyKey,
            step.tool_name,
            resolvedParameters
          );
          if (isDuplicate) {
            const keyHash = await idempotencyService.getKey(
              idempotencyKey,
              step.tool_name,
              resolvedParameters
            );
            console.log(`[Idempotency] Step ${step.tool_name} (${step.id}) already executed, skipping. Key: ${keyHash}`);
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

          // FAILOVER POLICY ENGINE: Check for semantic recovery options before marking as failed
          const failoverResult = await this.evaluateFailoverPolicy(step, resolvedParameters, toolResult.error, errorCode);

          // Handle circuit breaker trip - escalate to human
          if (failoverResult.circuitBroken) {
            console.warn(
              `[WorkflowMachine] LLM correction circuit breaker tripped for ${step.tool_name}. ` +
              `Escalating to human intervention.`
            );
            
            await RealtimeService.publishStreamingStatusUpdate({
              executionId: this.executionId,
              stepIndex,
              totalSteps,
              stepName: step.tool_name,
              status: 'failed',
              message: 'Automatic correction exhausted. Human intervention required.',
              timestamp: new Date().toISOString(),
              traceId: traceId,
            });

            return {
              stepState: {
                step_id: step.id,
                status: "failed",
                error: {
                  code: "LLM_CIRCUIT_BROKEN",
                  message: "Automatic correction failed multiple times. Human intervention required.",
                  httpCode: 409,
                  suggestions: failoverResult.suggestions,
                },
                completed_at: new Date().toISOString(),
                latency_ms: latencyMs,
                attempts: (getStepState(state, step.id)?.attempts || 0) + 1,
              },
            };
          }

          if (failoverResult.shouldRetry) {
            console.log(
              `[WorkflowMachine] Failover policy triggered for ${step.tool_name}: ${failoverResult.policyName}`
            );

            // Try the failover action (e.g., alternative time, alternative restaurant)
            if (failoverResult.retryParameters) {
              const retryResult = await toolExecutor.execute(
                step.tool_name,
                failoverResult.retryParameters,
                step.timeout_ms
              );

              if (retryResult.success) {
                // RESET CIRCUIT BREAKER on successful recovery
                await this.resetCircuitBreaker(this.executionId, step.id);

                await RealtimeService.publishStreamingStatusUpdate({
                  executionId: this.executionId,
                  stepIndex,
                  totalSteps,
                  stepName: step.tool_name,
                  status: 'completed',
                  message: `Completed ${step.description || step.tool_name} (failover recovery)`,
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
            message: `Failed: ${typeof toolResult.error === 'string' ? toolResult.error : 'Unknown error'}${failoverResult.policyName ? ` [${failoverResult.policyName}]` : ''}`,
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
                failoverPolicy: failoverResult.policyName,
                failoverSuggestions: failoverResult.suggestions,
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

  // ========================================================================
  // LLM CIRCUIT BREAKER
  // Prevents infinite correction loops and budget bleed
  // ========================================================================

  /**
   * Check if the LLM correction circuit breaker is open
   * Returns true if circuit is open (should NOT call LLM)
   */
  private async isCircuitBreakerOpen(executionId: string, stepId: string): Promise<boolean> {
    const circuitKey = `llm:circuit:${executionId}:${stepId}`;
    
    try {
      const circuitState = await redis.get<{
        isOpen: boolean;
        openedAt: number;
        attemptCount: number;
      }>(circuitKey);

      if (!circuitState) {
        return false; // No circuit state = closed (allow LLM calls)
      }

      // Check if circuit has timed out
      const now = Date.now();
      if (circuitState.isOpen && (now - circuitState.openedAt) > LLM_CIRCUIT_BREAKER_CONFIG.openTimeoutMs) {
        // Circuit timeout expired - allow half-open state (one test call)
        console.log(`[CircuitBreaker] Circuit timeout expired for ${stepId}, allowing test call`);
        return false;
      }

      return circuitState.isOpen;
    } catch (error) {
      console.error(`[CircuitBreaker] Failed to check circuit state:`, error);
      return false; // Fail open - allow LLM calls if Redis fails
    }
  }

  /**
   * Record an LLM correction attempt
   * Trips the circuit breaker if max attempts exceeded
   */
  private async recordCorrectionAttempt(executionId: string, stepId: string): Promise<{
    shouldProceed: boolean;
    attemptCount: number;
  }> {
    const circuitKey = `llm:circuit:${executionId}:${stepId}`;
    const windowKey = `llm:window:${executionId}:${stepId}`;
    
    try {
      // Use a sliding window to count attempts
      const now = Date.now();
      const windowStart = now - LLM_CIRCUIT_BREAKER_CONFIG.windowMs;
      
      // Add current attempt to sorted set with timestamp as score
      await redis.zadd(windowKey, { score: now, member: `${now}-${crypto.randomUUID()}` });
      
      // Remove old attempts outside the window
      await redis.zremrangebyscore(windowKey, 0, windowStart);
      
      // Count attempts in current window
      const attemptCount = await redis.zcard(windowKey);
      
      // Set TTL on window key
      await redis.expire(windowKey, LLM_CIRCUIT_BREAKER_CONFIG.ttlSeconds);

      // Check if we exceeded max attempts
      if (attemptCount > LLM_CIRCUIT_BREAKER_CONFIG.maxAttempts) {
        // Trip the circuit breaker
        await redis.setex(
          circuitKey,
          LLM_CIRCUIT_BREAKER_CONFIG.ttlSeconds,
          JSON.stringify({
            isOpen: true,
            openedAt: now,
            attemptCount,
            reason: `Exceeded ${LLM_CIRCUIT_BREAKER_CONFIG.maxAttempts} attempts in ${LLM_CIRCUIT_BREAKER_CONFIG.windowMs / 1000}s`,
          })
        );
        
        console.warn(
          `[CircuitBreaker] TRIPPED for ${stepId} after ${attemptCount} attempts. ` +
          `Will reopen in ${LLM_CIRCUIT_BREAKER_CONFIG.openTimeoutMs / 1000}s`
        );
        
        return { shouldProceed: false, attemptCount };
      }

      return { shouldProceed: true, attemptCount };
    } catch (error) {
      console.error(`[CircuitBreaker] Failed to record correction attempt:`, error);
      return { shouldProceed: true, attemptCount: 0 }; // Fail open
    }
  }

  /**
   * Reset the circuit breaker after successful recovery
   */
  private async resetCircuitBreaker(executionId: string, stepId: string): Promise<void> {
    const circuitKey = `llm:circuit:${executionId}:${stepId}`;
    const windowKey = `llm:window:${executionId}:${stepId}`;
    
    try {
      await redis.del(circuitKey);
      await redis.del(windowKey);
      console.log(`[CircuitBreaker] RESET for ${stepId} after successful recovery`);
    } catch (error) {
      console.error(`[CircuitBreaker] Failed to reset circuit breaker:`, error);
    }
  }

  /**
   * Evaluate failover policy for step failure
   * Maps tool errors to failure reasons and checks for semantic recovery options
   * 
   * Integrated with LLM Circuit Breaker to prevent budget bleed from correction loops
   */
  private async evaluateFailoverPolicy(
    step: PlanStep,
    parameters: Record<string, unknown>,
    error: string | undefined,
    errorCode: number | undefined
  ): Promise<{
    shouldRetry: boolean;
    policyName?: string;
    retryParameters?: Record<string, unknown>;
    suggestions?: Array<{ type: string; value: unknown; confidence: number }>;
    circuitBroken?: boolean;
  }> {
    // CIRCUIT BREAKER CHECK - Prevent LLM budget bleed
    const circuitOpen = await this.isCircuitBreakerOpen(this.executionId, step.id);
    if (circuitOpen) {
      console.warn(
        `[WorkflowMachine] Circuit breaker OPEN for ${step.tool_name} (${step.id}). ` +
        `Skipping LLM-based failover correction. Escalating to human intervention.`
      );
      return {
        shouldRetry: false,
        circuitBroken: true,
        suggestions: [{
          type: 'human_intervention',
          value: {
            reason: 'LLM correction loop detected',
            message: 'Automatic correction failed multiple times. Human review required.',
          },
          confidence: 1.0,
        }],
      };
    }

    // Map error message to failure reason
    const failureReason = this.mapErrorToFailureReason(error, errorCode);

    if (!failureReason) {
      return { shouldRetry: false };
    }

    // Determine intent type from tool name
    const intentType = this.mapToolNameToIntentType(step.tool_name);

    if (!intentType) {
      return { shouldRetry: false };
    }

    // RECORD CORRECTION ATTEMPT - May trip circuit breaker
    const correctionResult = await this.recordCorrectionAttempt(this.executionId, step.id);
    if (!correctionResult.shouldProceed) {
      console.warn(
        `[WorkflowMachine] Correction attempt blocked by circuit breaker for ${step.tool_name}. ` +
        `Attempt #${correctionResult.attemptCount}`
      );
      return {
        shouldRetry: false,
        circuitBroken: true,
        suggestions: [{
          type: 'human_intervention',
          value: {
            reason: 'Max correction attempts exceeded',
            attempts: correctionResult.attemptCount,
            message: 'Automatic correction exhausted. Human review required.',
          },
          confidence: 1.0,
        }],
      };
    }

    // Build evaluation context
    const context: {
      intent_type: string;
      failure_reason: string;
      party_size?: number;
      requested_time?: string;
      restaurant_tags?: string[];
      attempt_count?: number;
    } = {
      intent_type: intentType,
      failure_reason: failureReason,
      attempt_count: correctionResult.attemptCount,
    };

    // Extract context from parameters
    if (typeof parameters.party_size === 'number') {
      context.party_size = parameters.party_size;
    }
    if (typeof parameters.time === 'string') {
      context.requested_time = parameters.time;
    }
    if (typeof parameters.restaurant_tags === 'string') {
      context.restaurant_tags = [parameters.restaurant_tags];
    }

    // Evaluate against failover policies
    const result = this.failoverPolicyEngine.evaluate(context as any);

    if (!result.matched || !result.recommended_action) {
      return { shouldRetry: false };
    }

    console.log(
      `[WorkflowMachine] Failover policy matched: "${result.policy?.name}" with action ${result.recommended_action.type}`
    );

    // Generate retry parameters based on recommended action
    const retryParameters = await this.generateRetryParameters(
      result.recommended_action.type,
      step,
      parameters,
      result
    );

    // Get alternative suggestions
    const suggestions = this.failoverPolicyEngine.getAlternativeSuggestions(
      context as any,
      result
    );

    return {
      shouldRetry: !!retryParameters,
      policyName: result.policy?.name,
      retryParameters: retryParameters ?? undefined,
      suggestions,
    };
  }

  /**
   * Map error message to failure reason enum
   */
  private mapErrorToFailureReason(
    error: string | undefined,
    errorCode: number | undefined
  ): string | null {
    if (!error) return null;

    const errorLower = error.toLowerCase();

    if (errorLower.includes('full') || errorLower.includes('no availability') || errorLower.includes('fully booked')) {
      return 'RESTAURANT_FULL';
    }
    if (errorLower.includes('unavailable') || errorLower.includes('not available')) {
      return 'TABLE_UNAVAILABLE';
    }
    if (errorLower.includes('overload') || errorLower.includes('busy') || errorLower.includes('high volume')) {
      return 'KITCHEN_OVERLOADED';
    }
    if (errorLower.includes('payment') || errorLower.includes('card') || errorLower.includes('charge')) {
      return 'PAYMENT_FAILED';
    }
    if (errorLower.includes('delivery') && (errorLower.includes('unavailable') || errorLower.includes('not available'))) {
      return 'DELIVERY_UNAVAILABLE';
    }
    if (errorLower.includes('time slot') || errorLower.includes('time not available')) {
      return 'TIME_SLOT_UNAVAILABLE';
    }
    if (errorLower.includes('party size') || errorLower.includes('too large') || errorLower.includes('exceeds')) {
      return 'PARTY_SIZE_TOO_LARGE';
    }
    if (errorLower.includes('invalid') || errorLower.includes('validation')) {
      return 'VALIDATION_FAILED';
    }
    if (errorLower.includes('timeout')) {
      return 'TIMEOUT';
    }
    if (errorCode && errorCode >= 500) {
      return 'SERVICE_ERROR';
    }

    return null;
  }

  /**
   * Map tool name to intent type for failover policy evaluation
   */
  private mapToolNameToIntentType(toolName: string): string | null {
    const toolLower = toolName.toLowerCase();
    
    if (toolLower.includes('reserve') || toolLower.includes('book') || toolLower.includes('table')) {
      return 'BOOKING';
    }
    if (toolLower.includes('delivery') || toolLower.includes('dispatch') || toolLower.includes('fulfill')) {
      return 'DELIVERY';
    }
    if (toolLower.includes('waitlist')) {
      return 'WAITLIST';
    }
    if (toolLower.includes('modify') || toolLower.includes('update') || toolLower.includes('cancel')) {
      return 'RESERVATION_MODIFY';
    }
    if (toolLower.includes('payment') || toolLower.includes('charge') || toolLower.includes('stripe')) {
      return 'PAYMENT';
    }

    return null;
  }

  /**
   * Generate retry parameters based on failover action type
   */
  private async generateRetryParameters(
    actionType: string,
    step: PlanStep,
    originalParams: Record<string, unknown>,
    policyResult: any
  ): Promise<Record<string, unknown> | null> {
    switch (actionType) {
      case 'SUGGEST_ALTERNATIVE_TIME': {
        // Try alternative time slots based on policy parameters
        const offsets = (policyResult.recommended_action.parameters?.time_offset_minutes as number[]) || [-30, 30];
        const originalTime = originalParams.time as string | undefined;
        
        if (!originalTime) return null;
        
        // Parse time and apply first offset (simplified - in production would try all)
        const [hours, minutes] = originalTime.split(':').map(Number);
        const baseMinutes = hours * 60 + minutes;
        const offsetMinutes = offsets[0] || 30;
        const newMinutes = baseMinutes + offsetMinutes;
        
        if (newMinutes >= 0 && newMinutes < 24 * 60) {
          const newHours = Math.floor(newMinutes / 60);
          const newMins = newMinutes % 60;
          const newTime = `${newHours.toString().padStart(2, '0')}:${newMins.toString().padStart(2, '0')}`;
          
          return {
            ...originalParams,
            time: newTime,
          };
        }
        
        return null;
      }

      case 'TRIGGER_DELIVERY': {
        // Convert booking to delivery - this would require a different tool
        // For now, return null to let the booking fail and trigger delivery as separate step
        return null;
      }

      case 'TRIGGER_WAITLIST': {
        // Would trigger add_to_waitlist tool instead
        return null;
      }

      case 'DOWNGRADE_PARTY_SIZE': {
        const maxSize = (policyResult.recommended_action.parameters?.max_table_size as number) || 8;
        const currentSize = originalParams.party_size as number | undefined;
        
        if (currentSize && currentSize > maxSize) {
          return {
            ...originalParams,
            party_size: maxSize,
          };
        }
        
        return null;
      }

      case 'RETRY_WITH_BACKOFF': {
        // Just retry with same parameters - backoff is handled by caller
        return originalParams;
      }

      default:
        return null;
    }
  }

  /**
   * ADAPTIVE BATCHING: Determine if we should yield execution
   *
   * Intelligent yield decision based on:
   * 1. Elapsed time in current segment
   * 2. Estimated time for next step
   * 3. Buffer time needed for checkpoint + QStash trigger
   *
   * This reduces cold start penalties by maximizing lambda utilization
   * while ensuring we always have enough time to checkpoint safely.
   *
   * @param elapsedInSegment - Milliseconds elapsed in current segment
   * @returns true if we should yield, false if we can continue
   */
  private shouldYieldExecution(elapsedInSegment: number): boolean {
    // If we haven't reached minimum elapsed time, don't yield
    if (elapsedInSegment < ADAPTIVE_BATCHING_CONFIG.minElapsedBeforeYieldCheck) {
      return false;
    }

    // Calculate projected time if we execute more steps
    const projectedTime = elapsedInSegment + ADAPTIVE_BATCHING_CONFIG.estimatedStepDurationMs;
    const thresholdWithBuffer = CHECKPOINT_THRESHOLD_MS + ADAPTIVE_BATCHING_CONFIG.yieldBufferMs;

    // Yield if projected time exceeds threshold with buffer
    if (projectedTime >= thresholdWithBuffer) {
      console.log(
        `[WorkflowMachine:AdaptiveBatching] Projected time (${projectedTime}ms) exceeds threshold (${thresholdWithBuffer}ms), yielding`
      );
      return true;
    }

    // Don't yield if we're still in safe zone
    return false;
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
   * 
   * ENHANCEMENT (Task 2 & 4):
   * - Treats compensation as its own retryable mini-workflow
   * - Emits SAGA_MANUAL_INTERVENTION_REQUIRED to Ably if compensation fails
   * - Implements retry logic for compensation actions
   */
  private async executeCompensation(): Promise<WorkflowResult> {
    console.log(
      `[WorkflowMachine] Executing compensation for workflow ${this.workflowId}`
    );

    // Note: Can't transition to "COMPENSATING" as it's not in the ExecutionStatus enum
    // We'll just execute the compensation directly

    const MAX_COMPENSATION_ATTEMPTS = 3;
    let compensated = 0;
    let failed = 0;
    const compensationFailures: Array<{
      stepId: string;
      compensationTool: string;
      error: string;
      attempts: number;
    }> = [];

    // Execute compensations in reverse order
    for (let i = this.compensationsRegistered.length - 1; i >= 0; i--) {
      const comp = this.compensationsRegistered[i];
      const stepState = getStepState(this.state, comp.stepId);

      if (!stepState || stepState.status !== "completed") {
        continue; // Only compensate completed steps
      }

      // MULTI-STEP COMPENSATION: Retry logic for compensation actions
      let compensationSuccess = false;
      let lastError: string | null = null;

      for (let attempt = 1; attempt <= MAX_COMPENSATION_ATTEMPTS; attempt++) {
        try {
          console.log(
            `[WorkflowMachine] Compensation attempt ${attempt}/${MAX_COMPENSATION_ATTEMPTS} for step ${comp.stepId}: ${comp.compensationTool}`
          );

          // Apply exponential backoff for retries
          if (attempt > 1) {
            const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
          }

          const result = await this.toolExecutor.execute(
            comp.compensationTool,
            comp.parameters,
            30000
          );

          if (result.success) {
            compensationSuccess = true;
            compensated++;
            console.log(
              `[WorkflowMachine] Compensation successful for step ${comp.stepId}: ${comp.compensationTool}`
            );
            break; // Exit retry loop
          } else {
            lastError = result.error || "Unknown error";
            console.warn(
              `[WorkflowMachine] Compensation attempt ${attempt} failed for step ${comp.stepId}: ${result.error}`
            );
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          console.error(
            `[WorkflowMachine] Compensation attempt ${attempt} error for step ${comp.stepId}:`,
            lastError
          );
        }
      }

      if (!compensationSuccess) {
        failed++;
        compensationFailures.push({
          stepId: comp.stepId,
          compensationTool: comp.compensationTool,
          error: lastError || "Unknown error",
          attempts: MAX_COMPENSATION_ATTEMPTS,
        });
        console.error(
          `[WorkflowMachine] Compensation exhausted after ${MAX_COMPENSATION_ATTEMPTS} attempts for step ${comp.stepId}`
        );
      }
    }

    // HUMAN-IN-THE-LOOP: Emit alert if compensation fails
    if (failed > 0) {
      console.error(
        `[WorkflowMachine] ${failed} compensations failed. Emitting SAGA_MANUAL_INTERVENTION_REQUIRED event.`
      );

      try {
        await RealtimeService.publishNervousSystemEvent(
          "SAGA_MANUAL_INTERVENTION_REQUIRED",
          {
            workflowId: this.workflowId,
            executionId: this.executionId,
            intentId: this.intentId,
            failedCompensations: compensationFailures,
            successfulCompensations: compensated,
            totalCompensations: this.compensationsRegistered.length,
            requiresHumanIntervention: true,
            interventionReason: "Compensation actions exhausted all retry attempts",
            timestamp: new Date().toISOString(),
            traceId: this.traceId,
          },
          this.traceId
        );

        // Also publish to system alerts channel for monitoring dashboards
        await RealtimeService.publish('system:alerts', 'saga_compensation_failed', {
          workflowId: this.workflowId,
          executionId: this.executionId,
          failedCompensations: compensationFailures,
          severity: 'HIGH',
          requiresAction: true,
          timestamp: new Date().toISOString(),
        });

        console.log(
          `[WorkflowMachine] Published SAGA_MANUAL_INTERVENTION_REQUIRED event for ${this.executionId}`
        );
      } catch (publishError) {
        console.error(
          `[WorkflowMachine] Failed to publish intervention event:`,
          publishError
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
      // Store compensation failure details in state for audit
      this.state = applyStateUpdate(this.state, {
        status: "FAILED",
        context: {
          ...this.state.context,
          compensationStatus: "PARTIALLY_COMPENSATED",
          compensatedSteps: compensated,
          failedCompensations: failed,
          compensationFailures: compensationFailures,
          requiresHumanIntervention: true,
        },
        error: {
          code: "COMPENSATION_FAILED",
          message: `${failed} compensations failed after ${MAX_COMPENSATION_ATTEMPTS} attempts each. Manual intervention required.`,
          details: {
            failedCompensations: compensationFailures,
            successfulCompensations: compensated,
          },
        },
      });
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
