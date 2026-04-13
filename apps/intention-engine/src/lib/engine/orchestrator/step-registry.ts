/**
 * Orchestration Step Registry
 *
 * Registry pattern for managing orchestration steps.
 * Allows the orchestrator to focus on sequencing while
 * individual steps handle their own logic.
 *
 * @see Task 3: Decompose God Orchestrators
 */

import {
  OrchestrationStep,
  OrchestrationContext,
  ExecutionRecord,
  StepStatus,
} from "./step-registry-types";

/**
 * Registry for orchestration steps
 */
export class StepRegistry {
  private steps: Map<string, OrchestrationStep> = new Map();
  private sequence: string[] = [];

  /**
   * Register a step
   */
  register(step: OrchestrationStep): void {
    if (this.steps.has(step.name)) {
      throw new Error(`Step "${step.name}" is already registered`);
    }
    this.steps.set(step.name, step);
  }

  /**
   * Get a step by name
   */
  get(name: string): OrchestrationStep | undefined {
    return this.steps.get(name);
  }

  /**
   * Define the execution sequence
   */
  defineSequence(stepNames: string[]): void {
    // Validate all steps exist
    for (const name of stepNames) {
      if (!this.steps.has(name)) {
        throw new Error(`Step "${name}" not found in registry`);
      }
    }
    this.sequence = stepNames;
  }

  /**
   * Get the sequence of steps to execute
   */
  getSequence(): OrchestrationStep[] {
    return this.sequence
      .map((name) => this.steps.get(name))
      .filter((step): step is OrchestrationStep => step !== undefined);
  }

  /**
   * Clear all registered steps
   */
  clear(): void {
    this.steps.clear();
    this.sequence = [];
  }

  /**
   * Get all registered step names
   */
  getStepNames(): string[] {
    return Array.from(this.steps.keys());
  }
}

/**
 * Execute steps in sequence with automatic rollback on failure
 */
export async function executeStepSequence(
  steps: OrchestrationStep[],
  initialContext: OrchestrationContext,
  onStepComplete?: (record: ExecutionRecord) => void,
): Promise<{
  context: OrchestrationContext;
  executionLog: ExecutionRecord[];
  success: boolean;
}> {
  const executionLog: ExecutionRecord[] = [];
  let context = initialContext;

  // Execute steps in sequence
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Check if step should execute
    if (step.shouldExecute && !step.shouldExecute(context)) {
      const record: ExecutionRecord = {
        stepName: step.name,
        status: StepStatus.SKIPPED,
        startedAt: performance.now(),
        completedAt: performance.now(),
      };
      executionLog.push(record);
      onStepComplete?.(record);
      continue;
    }

    const record: ExecutionRecord = {
      stepName: step.name,
      status: StepStatus.EXECUTING,
      startedAt: performance.now(),
    };

    try {
      // Execute step
      context = await step.execute(context);

      // Mark as successful
      record.status = StepStatus.SUCCESS;
      record.completedAt = performance.now();
      executionLog.push(record);
      onStepComplete?.(record);
    } catch (error) {
      // Mark as failed
      record.status = StepStatus.FAILED;
      record.completedAt = performance.now();
      record.error = error instanceof Error ? error : new Error(String(error));
      executionLog.push(record);
      onStepComplete?.(record);

      // Rollback completed steps in reverse order
      await rollbackCompletedSteps(steps.slice(0, i), context, executionLog);

      return {
        context,
        executionLog,
        success: false,
      };
    }
  }

  return {
    context,
    executionLog,
    success: true,
  };
}

/**
 * Rollback completed steps in reverse order
 */
async function rollbackCompletedSteps(
  steps: OrchestrationStep[],
  context: OrchestrationContext,
  executionLog: ExecutionRecord[],
): Promise<void> {
  // Rollback in reverse order
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.rollback) {
      try {
        await step.rollback(context);

        // Update execution log
        const record = executionLog.find(
          (r) => r.stepName === step.name && r.status === "SUCCESS",
        );
        if (record) {
          record.status = StepStatus.ROLLED_BACK;
        }
      } catch (rollbackError) {
        // Log rollback error but continue with other rollbacks
        console.error(`Failed to rollback step "${step.name}":`, rollbackError);
      }
    }
  }
}

/**
 * Global registry instance
 */
let globalRegistry: StepRegistry | null = null;

/**
 * Get or create the global step registry
 */
export function getStepRegistry(): StepRegistry {
  if (!globalRegistry) {
    globalRegistry = new StepRegistry();
  }
  return globalRegistry;
}

/**
 * Reset the global registry (for testing)
 */
export function resetStepRegistry(): void {
  globalRegistry = null;
}
