/**
 * Step Execution Service
 *
 * Encapsulates the business logic for executing individual steps in a saga.
 * Extracted from the execute-step API route to improve testability and separation of concerns.
 *
 * Responsibilities:
 * - Execute single steps via WorkflowMachine
 * - Handle failover policy evaluation
 * - Manage step idempotency
 * - Trigger next step recursively via QStash
 * - Handle automatic replanning on failures
 *
 * @see Phase 3.1: Route De-bloating & Abstraction
 */

import { NextRequest } from "next/server";
import { redis } from "@/lib/redis-client";
import { getToolRegistry } from "@/lib/engine/tools/registry";
import { loadExecutionState, saveExecutionState } from "@/lib/engine/memory";
import { RealtimeService, QStashService, FailoverPolicyEngine, type PolicyEvaluationContext } from "@repo/shared";
import { createRepairAgent, type ZombieSaga, type RepairResult } from "@repo/shared";
import { ExecutionState } from "@/lib/engine/types";
import { getCompletedSteps } from "@/lib/engine/state-machine";
import { NervousSystemObserver } from "@/lib/listeners/nervous-system-observer";
import { WorkflowMachine } from "@/lib/engine/workflow-machine";
import type { ToolExecutor as WorkflowToolExecutor } from "@/lib/engine/workflow-machine";
import { LockingService } from "@/lib/engine/locking";
import { verifyServiceToken } from "@repo/auth";

// ============================================================================
// TYPES
// ============================================================================

export interface StepExecutionResult {
  success: boolean;
  executionId: string;
  stepExecuted?: string;
  stepStatus: "completed" | "failed" | "pending" | "no_steps_remaining";
  completedSteps: number;
  totalSteps: number;
  isComplete: boolean;
  nextStepTriggered?: boolean;
  error?: {
    code: string;
    message: string;
  };
}

export interface StepExecutionContext {
  request: NextRequest;
  executionId: string;
  startStepIndex: number;
  startTime: number;
}

// ============================================================================
// STEP EXECUTION SERVICE
// ============================================================================

export class StepExecutionService {
  /**
   * Execute a single step in the saga
   * This is the main entry point for the service
   */
  async execute(
    executionId: string,
    startStepIndex: number,
    request: NextRequest
  ): Promise<StepExecutionResult> {
    const startTime = performance.now();

    try {
      // Extract trace context from request
      const traceId = request.headers.get("x-trace-id") || executionId;
      const correlationId = request.headers.get("x-correlation-id") || traceId;

      console.log(
        `[StepExecutionService] Starting step ${startStepIndex + 1} for execution ${executionId}` +
        ` [trace: ${traceId}]` +
        (correlationId !== traceId ? ` [correlation: ${correlationId}]` : '')
      );

      // Verify JWT token if present
      await this.verifyAuthToken(request, executionId, traceId);

      // Check idempotency lock
      const isIdempotent = await this.checkIdempotency(executionId, startStepIndex);
      if (!isIdempotent) {
        return this.handleIdempotentSkip(executionId, startStepIndex);
      }

      // Acquire execution lock
      const lock = await this.acquireExecutionLock(executionId);
      if (!lock) {
        return this.handleLockConflict(executionId);
      }

      try {
        // Load execution state
        const state = await loadExecutionState(executionId);
        if (!state) {
          return this.handleExecutionNotFound(executionId);
        }

        // Validate plan exists
        const plan = state.plan;
        if (!plan) {
          return this.handlePlanNotFound(executionId);
        }

        // Check if all steps are complete
        const allStepsComplete = this.checkAllStepsComplete(state);
        if (allStepsComplete) {
          return this.handleAllStepsComplete(state);
        }

        // Execute step via WorkflowMachine
        const result = await this.executeStepViaMachine(
          executionId,
          startStepIndex,
          state,
          plan,
          { traceId, correlationId }
        );

        // Handle failover policy if step failed
        if (!result.success && result.stepState.status === "failed") {
          await this.handleFailoverPolicy(executionId, plan, result, state, { traceId, correlationId });
        }

        // Trigger next step if successful
        if (result.success && !result.isComplete) {
          await this.triggerNextStep(executionId, result.completedSteps, { traceId, correlationId });
        }

        // Check for replanning marker
        await this.checkAndExecuteReplanning(executionId, state, { traceId, correlationId });

        return {
          success: result.success,
          executionId,
          stepExecuted: result.stepId,
          stepStatus: result.stepState.status,
          completedSteps: result.completedSteps,
          totalSteps: result.totalSteps,
          isComplete: result.isComplete,
          nextStepTriggered: result.success && !result.isComplete,
        };
      } finally {
        // Always release lock
        await lock.release();
      }
    } catch (error) {
      console.error("[StepExecutionService] Unhandled error:", error);

      return {
        success: false,
        executionId,
        stepStatus: "pending",
        completedSteps: 0,
        totalSteps: 0,
        isComplete: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // ============================================================================
  // AUTHENTICATION
  // ============================================================================

  private async verifyAuthToken(
    request: NextRequest,
    executionId: string,
    traceId: string
  ): Promise<void> {
    const authHeader = request.headers.get("authorization");
    const hasAuthToken = authHeader?.startsWith("Bearer ");

    if (hasAuthToken) {
      const token = authHeader.substring(7);
      const payload = await verifyServiceToken(token);

      if (!payload) {
        console.warn(`[StepExecutionService] Invalid JWT token for ${executionId} [trace: ${traceId}]`);
        throw new Error("Invalid or expired JWT token");
      }

      const service = (payload as any).service;
      const tokenExecutionId = (payload as any).executionId;

      if (tokenExecutionId && tokenExecutionId !== executionId) {
        console.warn(
          `[StepExecutionService] JWT executionId mismatch: token=${tokenExecutionId}, request=${executionId}`
        );
        throw new Error("JWT token execution ID does not match request");
      }

      console.log(
        `[StepExecutionService] JWT verified for service=${service} [trace: ${traceId}]`
      );
    }
    // Note: If no auth token, allow the request (backward compat for initial trigger)
  }

  // ============================================================================
  // LOCKING & IDEMPOTENCY
  // ============================================================================

  private async checkIdempotency(
    executionId: string,
    stepIndex: number
  ): Promise<boolean> {
    const result = await LockingService.acquireStepIdempotencyLock(
      executionId,
      stepIndex,
      3600 // 1 hour TTL
    );

    return result.acquired;
  }

  private async acquireExecutionLock(executionId: string) {
    const lockKey = `exec:${executionId}:lock`;
    return await LockingService.acquire(lockKey, {
      ttlSeconds: 30,
      operation: 'execute-step',
    });
  }

  private handleLockConflict(executionId: string): StepExecutionResult {
    console.warn(`[StepExecutionService] Lock already held for ${executionId}, aborting`);
    return {
      success: false,
      executionId,
      stepStatus: "pending",
      completedSteps: 0,
      totalSteps: 0,
      isComplete: false,
      error: {
        code: "LOCK_HELD",
        message: "Execution lock already held, skipping to prevent double execution",
      },
    };
  }

  private async handleIdempotentSkip(
    executionId: string,
    stepIndex: number
  ): Promise<StepExecutionResult> {
    console.warn(`[StepExecutionService] Step ${stepIndex} already executed for ${executionId}, skipping (idempotent)`);

    const state = await loadExecutionState(executionId);
    if (state) {
      const completedCount = getCompletedSteps(state).length;
      const plan = state.plan;
      const isComplete = plan ? completedCount === plan.steps.length : false;

      return {
        success: true,
        executionId,
        stepExecuted: undefined,
        stepStatus: "completed",
        completedSteps: completedCount,
        totalSteps: plan?.steps.length || 0,
        isComplete,
        nextStepTriggered: false,
      };
    }

    return {
      success: true,
      executionId,
      error: {
        code: "ALREADY_EXECUTED",
        message: "Step already executed (idempotent skip)",
      },
      stepStatus: "pending",
      completedSteps: 0,
      totalSteps: 0,
      isComplete: false,
    };
  }

  // ============================================================================
  // STATE VALIDATION
  // ============================================================================

  private handleExecutionNotFound(executionId: string): StepExecutionResult {
    return {
      success: false,
      executionId,
      stepStatus: "pending",
      completedSteps: 0,
      totalSteps: 0,
      isComplete: false,
      error: {
        code: "EXECUTION_NOT_FOUND",
        message: `Execution ${executionId} not found`,
      },
    };
  }

  private handlePlanNotFound(executionId: string): StepExecutionResult {
    return {
      success: false,
      executionId,
      stepStatus: "pending",
      completedSteps: 0,
      totalSteps: 0,
      isComplete: false,
      error: {
        code: "PLAN_NOT_FOUND",
        message: "No plan found in execution state",
      },
    };
  }

  private checkAllStepsComplete(state: ExecutionState): boolean {
    const plan = state.plan;
    if (!plan) return false;

    const completedStepIds = getCompletedSteps(state).map(s => s.step_id);
    return plan.steps.every(step => completedStepIds.includes(step.id));
  }

  private handleAllStepsComplete(state: ExecutionState): StepExecutionResult {
    const completedCount = getCompletedSteps(state).length;
    const hasFailedSteps = state.step_states.some(s => s.status === "failed");
    const plan = state.plan;

    return {
      success: !hasFailedSteps,
      executionId,
      stepExecuted: undefined,
      stepStatus: "no_steps_remaining",
      completedSteps: completedCount,
      totalSteps: plan?.steps.length || 0,
      isComplete: true,
      nextStepTriggered: false,
    };
  }

  // ============================================================================
  // STEP EXECUTION
  // ============================================================================

  private async executeStepViaMachine(
    executionId: string,
    startStepIndex: number,
    state: ExecutionState,
    plan: any,
    traceContext: { traceId: string; correlationId: string }
  ) {
    const toolExecutor = this.createToolExecutor(executionId);
    const machine = new WorkflowMachine(executionId, toolExecutor, {
      initialState: state,
    });

    console.log(
      `[StepExecutionService] Using WorkflowMachine to execute step ${startStepIndex + 1}/${plan.steps.length}`
    );

    const result = await machine.executeSingleStep(startStepIndex);

    // Save updated state
    const updatedState = machine.getState();
    await saveExecutionState(updatedState);

    return result;
  }

  private createToolExecutor(executionId: string): WorkflowToolExecutor {
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

  // ============================================================================
  // FAILOVER POLICY
  // ============================================================================

  private async handleFailoverPolicy(
    executionId: string,
    plan: any,
    result: any,
    state: ExecutionState,
    traceContext: { traceId: string; correlationId: string }
  ) {
    const executedStep = plan.steps.find((step: any) => step.id === result.stepId);

    // Track failed bookings
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

    // Evaluate failover policy
    const failoverContext: PolicyEvaluationContext = {
      intent_type: (state.intent?.type as any) || "BOOKING",
      failure_reason: this.mapFailureReason(result.stepState.error?.message),
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
        `[StepExecutionService] Matched policy "${failoverResult.policy?.name}" for failed step ${result.stepId}`
      );

      await this.storeFailoverState(executionId, failoverResult, failoverEngine, failoverContext);
      await this.publishFailoverEvent(executionId, failoverResult);

      // SELF-HEALING LOOP: Invoke RepairAgent for autonomous repair
      const repairSuccessful = await this.invokeRepairAgent(
        executionId,
        state,
        result,
        executedStep,
        traceContext
      );

      // If repair was successful, skip replanning (saga will resume with fixed params)
      if (repairSuccessful) {
        console.log(`[StepExecutionService] RepairAgent successfully repaired ${executionId}, skipping replanning`);
        return;
      }

      // Repair failed or not attempted - trigger automatic replanning
      await this.triggerAutomaticReplanning(executionId, failoverResult, failoverEngine, failoverContext, state);
    }
  }

  /**
   * Invoke RepairAgent for autonomous self-healing
   *
   * Converts the failed execution into a ZombieSaga and attempts automated repair.
   * If RepairAgent returns RETRY_WITH_MODIFIED_PARAMS, updates step parameters in Redis
   * and re-triggers the step once.
   *
   * @param executionId - Execution ID
   * @param state - Current execution state
   * @param result - Step execution result
   * @param executedStep - The failed step
   * @param traceContext - Trace context
   * @returns True if repair was successful and step will be retried
   */
  private async invokeRepairAgent(
    executionId: string,
    state: ExecutionState,
    result: any,
    executedStep: any,
    traceContext: { traceId: string; correlationId: string }
  ): Promise<boolean> {
    try {
      // Build ZombieSaga from failed execution
      const zombieSaga: ZombieSaga = {
        executionId,
        workflowId: state.plan?.id || `workflow:${executionId}`,
        intentId: state.intent?.id,
        userId: state.context?.userId as string | undefined,
        status: "failed",
        lastActivityAt: new Date().toISOString(),
        inactiveDurationMs: 0,
        stepStates: state.step_states.map((s) => ({
          step_id: s.step_id,
          status: s.status,
          error: s.error,
          tool_name: executedStep?.tool_name,
          parameters: s.input as Record<string, unknown> | undefined,
        })),
        compensationsRegistered: [],
        requiresHumanIntervention: false,
        recoveryAttempts: 0,
        failureContext: {
          errorCode: result.stepState.error?.code,
          errorMessage: result.stepState.error?.message,
          failedStepIndex: state.step_states.findIndex((s) => s.step_id === result.stepId),
          failedTool: executedStep?.tool_name,
        },
      };

      // Invoke RepairAgent
      const repairAgent = createRepairAgent({ debug: true });
      const repairResult = await repairAgent.analyzeAndRepair(zombieSaga);

      if (repairResult.success && repairResult.action === "AUTO_REPAIRED") {
        console.log(
          `[StepExecutionService] RepairAgent auto-repaired ${executionId}: ` +
          `${repairResult.repairAnalysis?.suggestedFix.type}`
        );

        // Extract adapted parameters if provided
        const adaptedParams = repairResult.repairAnalysis?.suggestedFix.parameters;

        if (adaptedParams && result.stepId) {
          // Update step parameters in Redis for retry
          await this.updateStepParametersForRetry(
            executionId,
            result.stepId,
            adaptedParams,
            traceContext
          );
          return true;
        }
      }

      return false;
    } catch (error) {
      console.error(`[StepExecutionService] RepairAgent invocation failed:`, error);
      return false;
    }
  }

  /**
   * Update step parameters in Redis and re-trigger the step
   *
   * Called when RepairAgent returns RETRY_WITH_MODIFIED_PARAMS.
   * Updates the step's input parameters and triggers QStash to retry the step.
   */
  private async updateStepParametersForRetry(
    executionId: string,
    stepId: string,
    adaptedParams: Record<string, unknown>,
    traceContext: { traceId: string; correlationId: string }
  ): Promise<void> {
    try {
      // Load current state
      const state = await loadExecutionState(executionId);
      if (!state || !state.plan) {
        throw new Error(`Execution state not found for ${executionId}`);
      }

      // Find the step index
      const stepIndex = state.plan.steps.findIndex((s) => s.id === stepId);
      if (stepIndex === -1) {
        throw new Error(`Step ${stepId} not found in plan`);
      }

      // Update step parameters in state
      state.plan.steps[stepIndex].parameters = {
        ...state.plan.steps[stepIndex].parameters,
        ...adaptedParams,
      };

      // Reset step state to pending for retry
      const stepStateIndex = state.step_states.findIndex((s) => s.step_id === stepId);
      if (stepStateIndex !== -1) {
        state.step_states[stepStateIndex] = {
          step_id: stepId,
          status: "pending",
          attempts: 0,
        };
      }

      // Save updated state
      await saveExecutionState(state);

      // Store retry marker in Redis
      const retryKey = `exec:${executionId}:retry:${stepId}`;
      await redis.setex(
        retryKey,
        300, // 5 minute TTL
        JSON.stringify({
          stepId,
          adaptedParams,
          retryCount: 1,
          timestamp: new Date().toISOString(),
          reason: "REPAIR_AGENT_MODIFIED_PARAMS",
        })
      );

      // Re-trigger the step via QStash
      const INTERNAL_SYSTEM_KEY = process.env.INTERNAL_SYSTEM_KEY || "";
      const messageId = await QStashService.triggerNextStep({
        executionId,
        stepIndex,
        internalKey: INTERNAL_SYSTEM_KEY,
        traceId: traceContext.traceId,
        correlationId: traceContext.correlationId,
      });

      console.log(
        `[StepExecutionService] Re-triggering step ${stepId} with adapted parameters ` +
        `[message: ${messageId || "fallback"}] [trace: ${traceContext.traceId}]`
      );
    } catch (error) {
      console.error(`[StepExecutionService] Failed to update parameters for retry:`, error);
      throw error;
    }
  }

  private mapFailureReason(errorMessage?: string): PolicyEvaluationContext["failure_reason"] {
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

  private async storeFailoverState(
    executionId: string,
    failoverResult: any,
    failoverEngine: FailoverPolicyEngine,
    failoverContext: PolicyEvaluationContext
  ) {
    const failoverKey = `exec:${executionId}:failover`;
    await redis.setex(
      failoverKey,
      3600,
      JSON.stringify({
        matched: true,
        policyId: failoverResult.policy?.id,
        policyName: failoverResult.policy?.name,
        recommendedAction: failoverResult.recommended_action,
        suggestions: failoverEngine.getAlternativeSuggestions(failoverContext, failoverResult),
        evaluatedAt: new Date().toISOString(),
      })
    );
  }

  private async publishFailoverEvent(executionId: string, failoverResult: any) {
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
      console.warn("[StepExecutionService] Failed to publish failover event to Ably:", err);
    }
  }

  private async triggerAutomaticReplanning(
    executionId: string,
    failoverResult: any,
    failoverEngine: FailoverPolicyEngine,
    failoverContext: PolicyEvaluationContext,
    state: ExecutionState
  ) {
    const shouldReplan = failoverResult.recommended_action && [
      "SUGGEST_ALTERNATIVE_TIME",
      "SUGGEST_ALTERNATIVE_RESTAURANT",
      "SUGGEST_ALTERNATIVE_DATE",
      "TRIGGER_DELIVERY",
      "TRIGGER_WAITLIST",
      "ESCALATE_TO_HUMAN",
    ].includes(failoverResult.recommended_action.type);

    if (shouldReplan && redis) {
      try {
        const replanKey = `exec:${executionId}:replan`;
        await redis.setex(
          replanKey,
          300,
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
          `[StepExecutionService] Marked execution ${executionId} for automatic replanning: ${failoverResult.recommended_action?.type}`
        );

        await this.publishReplanEvent(executionId, failoverResult);
      } catch (replanError) {
        console.warn("[StepExecutionService] Failed to mark for replanning:", replanError);
      }
    }
  }

  private async publishReplanEvent(executionId: string, failoverResult: any) {
    try {
      await RealtimeService.publish(
        "nervous-system:updates",
        "AutomaticReplanTriggered",
        {
          executionId,
          reason: failoverResult.policy?.name,
          actionType: failoverResult.recommended_action?.type,
          message: `Your request needs adjustment. ${failoverResult.recommended_action?.message_template}`,
          timestamp: new Date().toISOString(),
        },
        {}
      );
    } catch (err) {
      console.warn("[StepExecutionService] Failed to publish replan event to Ably:", err);
    }
  }

  // ============================================================================
  // RECURSIVE TRIGGER
  // ============================================================================

  private async triggerNextStep(
    executionId: string,
    currentStepIndex: number,
    traceContext: { traceId: string; correlationId: string }
  ) {
    const INTERNAL_SYSTEM_KEY = process.env.INTERNAL_SYSTEM_KEY || "";
    
    const messageId = await QStashService.triggerNextStep({
      executionId,
      stepIndex: currentStepIndex + 1,
      internalKey: INTERNAL_SYSTEM_KEY,
      traceId: traceContext.traceId,
      correlationId: traceContext.correlationId,
    });

    if (messageId) {
      console.log(
        `[StepExecutionService] QStash message sent for next step [message: ${messageId}]` +
        ` [trace: ${traceContext.traceId}]`
      );
    }
  }

  // ============================================================================
  // REPLANNING
  // ============================================================================

  private async checkAndExecuteReplanning(
    executionId: string,
    state: ExecutionState,
    traceContext: { traceId: string; correlationId: string }
  ) {
    if (!redis) return;

    try {
      const replanKey = `exec:${executionId}:replan`;
      const replanData = await redis.get<any>(replanKey);

      if (!replanData || !replanData.shouldReplan) return;

      console.log(
        `[StepExecutionService] Execution ${executionId} marked for replanning, triggering new plan...`
      );

      const { generatePlan } = await import("@/lib/engine/planner");
      const { inferIntent } = await import("@/lib/engine/intent");

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

      const { hypotheses } = await inferIntent(newRawText, []);
      const newIntent = hypotheses.primary;
      const newPlan = await generatePlan(newRawText);

      const updatedState = await loadExecutionState(executionId);
      if (!updatedState) {
        throw new Error(`Execution state not found for ${executionId}`);
      }

      updatedState.intent = newIntent;
      updatedState.plan = newPlan;
      updatedState.status = "PLANNED";
      updatedState.step_states = newPlan.steps.map((step: any) => ({
        step_id: step.id,
        status: "pending",
        attempts: 0,
      }));

      await saveExecutionState(updatedState);
      await redis.del(replanKey);

      await QStashService.triggerNextStep({
        executionId,
        stepIndex: 0,
        internalKey: process.env.INTERNAL_SYSTEM_KEY || "",
        traceId: traceContext.traceId,
        correlationId: traceContext.correlationId,
      });

      console.log(
        `[StepExecutionService] Replanning complete for ${executionId}, new plan has ${newPlan.steps.length} steps` +
        ` [trace: ${traceContext.traceId}]`
      );
    } catch (replanError) {
      console.warn("[StepExecutionService] Failed to execute replanning:", replanError);
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createStepExecutionService(): StepExecutionService {
  return new StepExecutionService();
}
