/**
 * StepTransaction - Unified Saga Pattern Implementation
 * 
 * Wraps every tool call in a 'Step Transaction' that:
 * 1. Persists compensating actions before execution
 * 2. Tracks execution state for recovery
 * 3. Automatically triggers compensation on failure
 * 
 * This unifies the fragmented saga logic from orchestrator.ts and saga.ts
 * into a single, coherent transaction model.
 */

import {
  ExecutionState,
  ExecutionStatus,
  Plan,
  PlanStep,
  StepExecutionState,
} from "./types";
import {
  updateStepState,
  getStepState,
  getCompletedSteps,
} from "./state-machine";
import { saveExecutionState } from "./memory";
import { RealtimeService } from "@repo/shared";
import { ToolExecutor } from "./durable-execution";
import { COMPENSATIONS, needsCompensation, getCompensation, mapCompensationParameters } from "@repo/mcp-protocol";

// ============================================================================
// STEP TRANSACTION SCHEMA
// ============================================================================

export interface StepTransaction {
  stepId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  // Compensating action to undo this step
  compensation?: {
    toolName: string;
    parameters: Record<string, unknown>;
    // Whether compensation has been executed
    executed: boolean;
    // Compensation result
    result?: {
      success: boolean;
      output?: unknown;
      error?: string;
    };
  };
  // Execution state
  status: "pending" | "in_progress" | "completed" | "failed" | "compensating" | "compensated";
  result?: {
    success: boolean;
    output?: unknown;
    error?: string;
    latency_ms: number;
  };
  // Metadata
  startedAt?: string;
  completedAt?: string;
  attempts: number;
}

// ============================================================================
// SAGA CONTEXT
// Tracks all transactions in a saga
// ============================================================================

export interface SagaContext {
  sagaId: string;
  executionId: string;
  intentId?: string;
  traceId?: string;
  userId?: string;
  transactions: StepTransaction[];
  status: "running" | "completed" | "compensating" | "compensated" | "failed";
  startedAt: string;
  completedAt?: string;
  error?: {
    code: string;
    message: string;
    failedStepId?: string;
  };
}

// ============================================================================
// STEP TRANSACTION MANAGER
// ============================================================================

export class StepTransactionManager {
  private sagaContext: SagaContext;
  private toolExecutor: ToolExecutor;

  constructor(
    executionId: string,
    toolExecutor: ToolExecutor,
    options?: {
      sagaId?: string;
      intentId?: string;
      traceId?: string;
      userId?: string;
    }
  ) {
    this.sagaContext = {
      sagaId: options?.sagaId || `saga:${executionId}`,
      executionId,
      intentId: options?.intentId,
      traceId: options?.traceId,
      userId: options?.userId,
      transactions: [],
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.toolExecutor = toolExecutor;
  }

  /**
   * Initialize transactions from a plan
   */
  initializeFromPlan(plan: Plan): void {
    for (const step of plan.steps) {
      const transaction: StepTransaction = {
        stepId: step.id,
        toolName: step.tool_name,
        parameters: step.parameters,
        status: "pending",
        attempts: 0,
      };

      // Pre-register compensation if tool requires it
      if (needsCompensation(step.tool_name)) {
        const compDef = getCompensation(step.tool_name);
        if (compDef && compDef.toolName) {
          transaction.compensation = {
            toolName: compDef.toolName,
            parameters: {}, // Will be populated after execution
            executed: false,
          };
        }
      }

      this.sagaContext.transactions.push(transaction);
    }
  }

  /**
   * Execute a single step transaction with compensation tracking
   */
  async executeTransaction(
    transaction: StepTransaction,
    executionState: ExecutionState
  ): Promise<{
    success: boolean;
    output?: unknown;
    error?: string;
    compensationRegistered?: boolean;
  }> {
    const timestamp = new Date().toISOString();
    transaction.status = "in_progress";
    transaction.startedAt = timestamp;
    transaction.attempts++;

    console.log(
      `[StepTransaction] Executing ${transaction.toolName} (${transaction.stepId})` +
      `[attempt ${transaction.attempts}]`
    );

    // Publish start event
    await this.publishTransactionEvent("TransactionStarted", transaction);

    try {
      // Execute the tool
      const result = await this.toolExecutor.execute(
        transaction.toolName,
        transaction.parameters,
        30000 // 30s timeout for individual steps
      );

      transaction.result = result;

      if (result.success) {
        transaction.status = "completed";
        transaction.completedAt = new Date().toISOString();

        // AUTO-REGISTER COMPENSATION
        if (!transaction.compensation && needsCompensation(transaction.toolName)) {
          const compDef = getCompensation(transaction.toolName);
          if (compDef && compDef.toolName) {
            const mappedParams = mapCompensationParameters(
              transaction.toolName,
              transaction.parameters,
              result.output
            );
            transaction.compensation = {
              toolName: compDef.toolName,
              parameters: mappedParams,
              executed: false,
            };
            console.log(
              `[StepTransaction] Registered compensation for ${transaction.toolName}: ` +
              `${compDef.toolName}`
            );
          }
        }

        // Persist compensation to execution state
        if (transaction.compensation) {
          executionState.context = {
            ...executionState.context,
            [`compensation:${transaction.stepId}`]: transaction.compensation,
          };
          await saveExecutionState(executionState);
        }

        // Publish completion event
        await this.publishTransactionEvent("TransactionCompleted", transaction);

        return {
          success: true,
          output: result.output,
          compensationRegistered: !!transaction.compensation,
        };
      } else {
        transaction.status = "failed";
        transaction.completedAt = new Date().toISOString();

        // Publish failure event
        await this.publishTransactionEvent("TransactionFailed", transaction);

        return {
          success: false,
          error: result.error,
        };
      }
    } catch (error: any) {
      transaction.status = "failed";
      transaction.completedAt = new Date().toISOString();
      transaction.result = {
        success: false,
        error: error.message,
        latency_ms: 0,
      };

      // Publish failure event
      await this.publishTransactionEvent("TransactionFailed", transaction);

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Execute compensation for a failed transaction
   */
  async executeCompensation(
    transaction: StepTransaction,
    executionState: ExecutionState
  ): Promise<{
    success: boolean;
    output?: unknown;
    error?: string;
  }> {
    if (!transaction.compensation) {
      console.warn(
        `[StepTransaction] No compensation defined for ${transaction.toolName}`
      );
      return {
        success: false,
        error: "No compensation defined",
      };
    }

    if (transaction.compensation.executed) {
      console.log(
        `[StepTransaction] Compensation already executed for ${transaction.toolName}`
      );
      return {
        success: true,
        output: transaction.compensation.result?.output,
      };
    }

    transaction.status = "compensating";
    console.log(
      `[StepTransaction] Executing compensation for ${transaction.toolName}: ` +
      `${transaction.compensation.toolName}`
    );

    // Publish compensation start event
    await this.publishTransactionEvent("CompensationStarted", transaction);

    try {
      const result = await this.toolExecutor.execute(
        transaction.compensation.toolName,
        transaction.compensation.parameters,
        30000
      );

      transaction.compensation.executed = true;
      transaction.compensation.result = result;

      if (result.success) {
        transaction.status = "compensated";
        transaction.completedAt = new Date().toISOString();

        // Update execution state
        executionState.context = {
          ...executionState.context,
          [`compensation:${transaction.stepId}`]: transaction.compensation,
        };
        await saveExecutionState(executionState);

        // Publish completion event
        await this.publishTransactionEvent("CompensationCompleted", transaction);

        return {
          success: true,
          output: result.output,
        };
      } else {
        // Compensation failed, but we still mark it as attempted
        transaction.status = "compensated";
        transaction.compensation.executed = true;

        console.error(
          `[StepTransaction] Compensation failed for ${transaction.toolName}: ` +
          `${result.error}`
        );

        await this.publishTransactionEvent("CompensationFailed", transaction);

        return {
          success: false,
          error: result.error,
        };
      }
    } catch (error: any) {
      transaction.status = "compensated";
      transaction.compensation.executed = true;
      transaction.compensation.result = {
        success: false,
        error: error.message,
      };

      console.error(
        `[StepTransaction] Compensation error for ${transaction.toolName}:`,
        error.message
      );

      await this.publishTransactionEvent("CompensationFailed", transaction);

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Execute compensations for all completed transactions in reverse order
   */
  async executeAllCompensations(
    executionState: ExecutionState,
    failedStepId: string
  ): Promise<{
    compensated: number;
    failed: number;
  }> {
    console.log(
      `[StepTransaction] Starting compensation for saga after step ${failedStepId} failed`
    );

    this.sagaContext.status = "compensating";

    let compensated = 0;
    let failed = 0;

    // Find the failed step index
    const failedIndex = this.sagaContext.transactions.findIndex(
      t => t.stepId === failedStepId
    );

    // Execute compensations in reverse order
    for (let i = failedIndex - 1; i >= 0; i--) {
      const transaction = this.sagaContext.transactions[i];

      if (transaction.status !== "completed") {
        continue; // Only compensate completed steps
      }

      const result = await this.executeCompensation(transaction, executionState);

      if (result.success) {
        compensated++;
      } else {
        failed++;
        console.error(
          `[StepTransaction] Compensation failed for step ${transaction.stepId}`
        );
      }
    }

    if (failed === 0) {
      this.sagaContext.status = "compensated";
    } else {
      this.sagaContext.status = "failed";
      this.sagaContext.error = {
        code: "COMPENSATION_PARTIAL",
        message: `${failed} compensations failed`,
      };
    }

    this.sagaContext.completedAt = new Date().toISOString();

    // Publish saga compensation event
    await RealtimeService.publishNervousSystemEvent(
      "SagaCompensated",
      {
        sagaId: this.sagaContext.sagaId,
        executionId: this.sagaContext.executionId,
        compensated,
        failed,
        totalTransactions: this.sagaContext.transactions.length,
        timestamp: new Date().toISOString(),
      },
      this.sagaContext.traceId
    );

    return { compensated, failed };
  }

  /**
   * Get saga context
   */
  getSagaContext(): SagaContext {
    return this.sagaContext;
  }

  /**
   * Publish transaction event to Nervous System
   */
  private async publishTransactionEvent(
    eventType: string,
    transaction: StepTransaction
  ): Promise<void> {
    try {
      await RealtimeService.publishNervousSystemEvent(
        eventType,
        {
          sagaId: this.sagaContext.sagaId,
          executionId: this.sagaContext.executionId,
          stepId: transaction.stepId,
          toolName: transaction.toolName,
          status: transaction.status,
          timestamp: new Date().toISOString(),
        },
        this.sagaContext.traceId
      );
    } catch (error) {
      console.warn(
        `[StepTransaction] Failed to publish event ${eventType}:`,
        error
      );
    }
  }
}

// ============================================================================
// SAGA EXECUTOR
// High-level API for executing sagas with automatic compensation
// ============================================================================

export interface SagaExecutionOptions {
  executionId: string;
  plan: Plan;
  toolExecutor: ToolExecutor;
  traceId?: string;
  userId?: string;
  intentId?: string;
}

export async function executeSaga(
  options: SagaExecutionOptions
): Promise<{
  success: boolean;
  sagaContext: SagaContext;
  executionState: ExecutionState;
}> {
  const { executionId, plan, toolExecutor, traceId, userId, intentId } = options;

  // Create transaction manager
  const transactionManager = new StepTransactionManager(
    executionId,
    toolExecutor,
    { sagaId: `saga:${executionId}`, traceId, userId, intentId }
  );

  // Initialize transactions from plan
  transactionManager.initializeFromPlan(plan);

  // Create or load execution state
  let executionState: ExecutionState = {
    execution_id: executionId,
    status: "EXECUTING",
    current_step_index: 0,
    step_states: plan.steps.map(step => ({
      step_id: step.id,
      status: "pending",
      attempts: 0,
    })),
    context: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    intent: intentId ? { id: intentId } as any : undefined,
    plan,
    latency_ms: 0,
    token_usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
    budget: {
      token_limit: 50000,
      cost_limit_usd: 0.50,
      current_cost_usd: 0,
    },
  };

  const sagaContext = transactionManager.getSagaContext();

  try {
    // Execute transactions in order (could be parallelized for independent steps)
    for (const transaction of sagaContext.transactions) {
      const result = await transactionManager.executeTransaction(
        transaction,
        executionState
      );

      // Update execution state
      const stepIndex = executionState.step_states.findIndex(
        s => s.step_id === transaction.stepId
      );
      if (stepIndex !== -1) {
        // Map transaction status to step execution status
        const stepStatus = transaction.status === "compensating" || transaction.status === "compensated"
          ? "completed" // For saga purposes, treat compensated as completed
          : transaction.status;
        
        executionState.step_states[stepIndex] = {
          step_id: transaction.stepId,
          status: stepStatus as any,
          input: transaction.parameters,
          output: result.output,
          error: result.error ? { code: "STEP_FAILED", message: result.error } : undefined,
          started_at: transaction.startedAt,
          completed_at: transaction.completedAt,
          attempts: transaction.attempts,
        };
      }

      if (!result.success) {
        // Execute compensations
        const compensationResult = await transactionManager.executeAllCompensations(
          executionState,
          transaction.stepId
        );

        executionState.status = "FAILED";
        executionState.completed_at = new Date().toISOString();
        executionState.error = {
          code: "SAGA_COMPENSATED",
          message: `Step ${transaction.stepId} failed. Compensated ${compensationResult.compensated} steps.`,
          step_id: transaction.stepId,
        };

        await saveExecutionState(executionState);

        return {
          success: false,
          sagaContext: transactionManager.getSagaContext(),
          executionState,
        };
      }
    }

    // All transactions completed successfully
    sagaContext.status = "completed";
    sagaContext.completedAt = new Date().toISOString();

    executionState.status = "COMPLETED";
    executionState.completed_at = new Date().toISOString();

    await saveExecutionState(executionState);

    // Publish saga completion event
    await RealtimeService.publishNervousSystemEvent(
      "SagaCompleted",
      {
        sagaId: sagaContext.sagaId,
        executionId: sagaContext.executionId,
        totalTransactions: sagaContext.transactions.length,
        timestamp: new Date().toISOString(),
      },
      traceId
    );

    return {
      success: true,
      sagaContext,
      executionState,
    };
  } catch (error: any) {
    // Unexpected error - try to compensate
    sagaContext.status = "failed";
    sagaContext.error = {
      code: "SAGA_FAILED",
      message: error.message,
    };
    sagaContext.completedAt = new Date().toISOString();

    executionState.status = "FAILED";
    executionState.completed_at = new Date().toISOString();
    executionState.error = {
      code: "SAGA_FAILED",
      message: error.message,
    };

    await saveExecutionState(executionState);

    return {
      success: false,
      sagaContext,
      executionState,
    };
  }
}
