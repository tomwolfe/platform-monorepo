/**
 * Trigger Execution Step
 *
 * Triggers the first step of the plan via QStash for async execution.
 * Extracted from orchestrator.ts for better testability.
 *
 * @see Task 3: Decompose God Orchestrators
 */

import {
  OrchestrationStep,
  OrchestrationContext,
} from "../step-registry-types";
import { QStashService } from "@repo/shared";
import { AppConfig } from "@repo/shared";
import { createTracer } from "@/lib/engine/tracing";

// Internal system key for QStash-triggered requests
const INTERNAL_SYSTEM_KEY = AppConfig.getInternalSystemKey();

export class TriggerExecutionStep implements OrchestrationStep {
  name = "trigger_execution";

  shouldExecute(context: OrchestrationContext): boolean {
    return !!context.plan;
  }

  async execute(context: OrchestrationContext): Promise<OrchestrationContext> {
    if (!context.plan) {
      throw new Error("Plan not found in context.");
    }

    // Add trace entry
    const tracer = createTracer(context.executionId);
    tracer.addSystemEntry("triggering_async_execution", {
      step_count: context.plan.steps.length,
    });

    // Trigger the FIRST step via QStash
    // This starts the recursive self-trigger chain
    await QStashService.triggerNextStep({
      executionId: context.executionId,
      stepIndex: 0,
      internalKey: INTERNAL_SYSTEM_KEY,
      traceId: context.executionId,
      correlationId: context.executionId,
    });

    return {
      ...context,
      correlations: {
        ...context.correlations,
        triggeredAsync: true,
        stepCount: context.plan.steps.length,
      },
    };
  }
}
