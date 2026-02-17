/**
 * SagaManager - Phase 3: Implement Saga Patterns for Workflows
 * 
 * Manages distributed sagas for cross-service transactions with automatic
 * compensating transactions on failure. Ensures eventual consistency without
 * distributed locks.
 * 
 * Pattern:
 * 1. Execute steps sequentially or in parallel
 * 2. On failure, execute compensations in reverse order
 * 3. Publish saga events for observability
 */

import { RealtimeService } from "@repo/shared";
import { ToolExecutor } from "./orchestrator";
import { StepExecutionState } from "./types";
import { createTypedSystemEvent, type SagaEventPayload } from "@repo/mcp-protocol";

export enum SagaStatus {
  STARTED = "STARTED",
  RUNNING = "RUNNING",
  COMPLETED = "COMPLETED",
  COMPENSATING = "COMPENSATING",
  COMPENSATED = "COMPENSATED",
  FAILED = "FAILED",
}

export enum SagaStepStatus {
  PENDING = "pending",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  COMPENSATING = "compensating",
  COMPENSATED = "compensated",
  SKIPPED = "skipped",
}

export interface SagaStep {
  id: string;
  toolName: string;
  parameters: Record<string, unknown>;
  compensation?: {
    toolName: string;
    parameters?: Record<string, unknown>;
    parameterMapper?: (stepResult: unknown, allResults: Record<string, unknown>) => Record<string, unknown>;
  };
  status: SagaStepStatus;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
  startedAt?: string;
  completedAt?: string;
}

export interface SagaContext {
  /** Unique saga identifier */
  sagaId: string;
  /** Execution ID from the engine */
  executionId: string;
  /** Optional intent ID for traceability */
  intentId?: string;
  /** Optional trace ID for distributed tracing */
  traceId?: string;
  /** User ID for audit purposes */
  userId?: string;
  /** Custom context data */
  metadata?: Record<string, unknown>;
}

export interface SagaDefinition {
  context: SagaContext;
  steps: SagaStep[];
  /** Whether to execute steps in parallel where possible */
  parallel?: boolean;
  /** Timeout for entire saga in milliseconds */
  timeoutMs?: number;
}

export interface SagaResult {
  sagaId: string;
  status: SagaStatus;
  steps: SagaStep[];
  completedSteps: number;
  failedSteps: number;
  compensatedSteps: number;
  startedAt: string;
  completedAt?: string;
  error?: {
    code: string;
    message: string;
    failedStepId?: string;
  };
}

export class SagaExecutionError extends Error {
  constructor(
    message: string,
    public readonly sagaId: string,
    public readonly failedStepId?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "SagaExecutionError";
  }
}

export class SagaManager {
  private toolExecutor: ToolExecutor;
  private activeSagas = new Map<string, SagaResult>();

  constructor(toolExecutor: ToolExecutor) {
    this.toolExecutor = toolExecutor;
  }

  /**
   * Execute a saga with automatic compensation on failure
   */
  async execute(definition: SagaDefinition): Promise<SagaResult> {
    const { context, steps, timeoutMs } = definition;
    const sagaId = context.sagaId;
    
    const result: SagaResult = {
      sagaId,
      status: SagaStatus.RUNNING,
      steps: steps.map(step => ({
        ...step,
        status: SagaStepStatus.PENDING,
        startedAt: new Date().toISOString(),
      })),
      completedSteps: 0,
      failedSteps: 0,
      compensatedSteps: 0,
      startedAt: new Date().toISOString(),
    };

    this.activeSagas.set(sagaId, result);

    // Publish saga started event
    await this.publishSagaEvent("SagaStarted", {
      sagaId,
      executionId: context.executionId,
      intentId: context.intentId,
      steps: result.steps.map(s => ({ id: s.id, toolName: s.toolName, status: s.status })),
    }, context.traceId);

    try {
      // Execute steps
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        
        // Check timeout
        if (timeoutMs) {
          const elapsed = Date.now() - new Date(result.startedAt).getTime();
          if (elapsed > timeoutMs) {
            throw new SagaExecutionError(
              `Saga ${sagaId} timed out after ${timeoutMs}ms`,
              sagaId,
              step.id
            );
          }
        }

        // Execute step
        result.steps[i].status = SagaStepStatus.RUNNING;
        result.steps[i].startedAt = new Date().toISOString();

        try {
          const stepResult = await this.executeStep(step, result.steps.slice(0, i).map(s => s.result));
          result.steps[i].status = SagaStepStatus.COMPLETED;
          result.steps[i].result = stepResult;
          result.steps[i].completedAt = new Date().toISOString();
          result.completedSteps++;

          // Build parameter map for compensation
          if (step.compensation?.parameterMapper) {
            const allResults = result.steps.reduce((acc, s, idx) => {
              acc[s.id] = s.result;
              return acc;
            }, {} as Record<string, unknown>);
            step.compensation.parameters = step.compensation.parameterMapper(stepResult, allResults);
          }
        } catch (error) {
          result.steps[i].status = SagaStepStatus.FAILED;
          result.steps[i].error = error instanceof Error 
            ? { code: "STEP_FAILED", message: error.message }
            : { code: "UNKNOWN", message: String(error) };
          result.steps[i].completedAt = new Date().toISOString();
          result.failedSteps++;

          // Trigger compensation
          result.status = SagaStatus.COMPENSATING;
          await this.compensate(result, i);
          result.status = SagaStatus.COMPENSATED;
          result.completedAt = new Date().toISOString();

          // Publish saga compensated event
          await this.publishSagaEvent("SagaCompensated", {
            sagaId,
            executionId: context.executionId,
            steps: result.steps.map(s => ({ id: s.id, toolName: s.toolName, status: s.status })),
            error: result.steps[i].error,
          }, context.traceId);

          this.activeSagas.set(sagaId, result);

          throw new SagaExecutionError(
            `Step ${step.id} (${step.toolName}) failed: ${result.steps[i].error?.message}`,
            sagaId,
            step.id,
            error
          );
        }
      }

      // All steps completed successfully
      result.status = SagaStatus.COMPLETED;
      result.completedAt = new Date().toISOString();

      // Publish saga completed event
      await this.publishSagaEvent("SagaCompleted", {
        sagaId,
        executionId: context.executionId,
        steps: result.steps.map(s => ({ id: s.id, toolName: s.toolName, status: s.status })),
      }, context.traceId);

      this.activeSagas.set(sagaId, result);
      return result;
    } catch (error) {
      if (error instanceof SagaExecutionError) {
        throw error;
      }

      // Unexpected error
      result.status = SagaStatus.FAILED;
      result.completedAt = new Date().toISOString();
      result.error = {
        code: "SAGA_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };

      this.activeSagas.set(sagaId, result);
      throw new SagaExecutionError(
        `Saga ${sagaId} failed: ${result.error.message}`,
        sagaId,
        undefined,
        error
      );
    }
  }

  /**
   * Execute a single step with the tool executor
   */
  private async executeStep(
    step: SagaStep,
    previousResults: unknown[]
  ): Promise<unknown> {
    const result = await this.toolExecutor.execute(
      step.toolName,
      step.parameters,
      30000 // Default 30s timeout
    );

    if (!result.success) {
      throw new Error(result.error || "Tool execution failed");
    }

    return result.output;
  }

  /**
   * Execute compensations for completed steps in reverse order
   */
  private async compensate(result: SagaResult, failedStepIndex: number): Promise<void> {
    const compensations: Promise<void>[] = [];

    // Execute compensations in reverse order
    for (let i = failedStepIndex - 1; i >= 0; i--) {
      const step = result.steps[i];
      
      if (step.status !== SagaStepStatus.COMPLETED) {
        continue;
      }

      if (!step.compensation) {
        console.warn(`[SagaManager] No compensation defined for step ${step.id} (${step.toolName})`);
        continue;
      }

      step.status = SagaStepStatus.COMPENSATING;

      const compensationPromise = (async () => {
        try {
          const compensationResult = await this.toolExecutor.execute(
            step.compensation!.toolName,
            step.compensation!.parameters || {},
            30000
          );

          if (compensationResult.success) {
            step.status = SagaStepStatus.COMPENSATED;
            step.completedAt = new Date().toISOString();
            result.compensatedSteps++;
          } else {
            console.error(
              `[SagaManager] Compensation failed for step ${step.id}: ${compensationResult.error}`
            );
            // Don't throw - continue with other compensations
          }
        } catch (error) {
          console.error(
            `[SagaManager] Compensation error for step ${step.id}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      })();

      compensations.push(compensationPromise);
    }

    await Promise.all(compensations);
  }

  /**
   * Get saga status
   */
  getSagaStatus(sagaId: string): SagaResult | undefined {
    return this.activeSagas.get(sagaId);
  }

  /**
   * Get all active sagas
   */
  getActiveSagas(): SagaResult[] {
    return Array.from(this.activeSagas.values());
  }

  /**
   * Publish saga events to the Nervous System mesh
   */
  private async publishSagaEvent(
    eventType: "SagaStarted" | "SagaCompleted" | "SagaCompensated",
    payload: {
      sagaId: string;
      executionId: string;
      intentId?: string;
      steps: Array<{ id: string; toolName: string; status: string }>;
      error?: { code: string; message: string };
    },
    traceId?: string
  ): Promise<void> {
    try {
      // Phase 2: Use structured SystemEvent schema
      const event = createTypedSystemEvent(
        eventType,
        payload as SagaEventPayload,
        "intention-engine",
        { traceId }
      );

      await RealtimeService.publishNervousSystemEvent(
        event.type,
        event.payload,
        event.traceId
      );
    } catch (error) {
      console.warn("[SagaManager] Failed to publish event to mesh:", error);
    }
  }
}

/**
 * Helper to create a saga step with compensation
 */
export function createSagaStep<T extends Record<string, unknown>>(
  id: string,
  toolName: string,
  parameters: T,
  compensation?: {
    toolName: string;
    parameterMapper?: (stepResult: unknown, allResults: Record<string, unknown>) => Record<string, unknown>;
  }
): SagaStep {
  return {
    id,
    toolName,
    parameters,
    compensation,
    status: SagaStepStatus.PENDING,
  };
}

/**
 * Common compensation parameter mappers
 */
export const CompensationMappers = {
  /**
   * Use the result ID from the original step for cancellation
   */
  useResultId: (resultKey: string) => (stepResult: unknown): Record<string, unknown> => {
    if (typeof stepResult === "object" && stepResult !== null && resultKey in stepResult) {
      return { [resultKey]: (stepResult as Record<string, unknown>)[resultKey] };
    }
    return {};
  },

  /**
   * Map reservation ID to cancellation
   */
  cancelReservation: (stepResult: unknown): Record<string, unknown> => {
    if (typeof stepResult === "object" && stepResult !== null && "booking_id" in stepResult) {
      return { reservationId: (stepResult as Record<string, unknown>).booking_id };
    }
    return {};
  },

  /**
   * Map delivery order ID to cancellation
   */
  cancelDelivery: (stepResult: unknown): Record<string, unknown> => {
    if (typeof stepResult === "object" && stepResult !== null && "orderId" in stepResult) {
      return { orderId: (stepResult as Record<string, unknown>).orderId };
    }
    return {};
  },
};
