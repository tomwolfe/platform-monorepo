/**
 * Generate Plan Step
 *
 * Pure function that generates an execution plan from parsed intent.
 * Extracted from orchestrator.ts for better testability.
 *
 * @see Task 3: Decompose God Orchestrators
 */

import {
  OrchestrationStep,
  OrchestrationContext,
} from "../step-registry-types";
import { generatePlan, PlannerResult } from "@/lib/engine/planner";
import { getRegistryManager } from "@/lib/engine/registry";
import { createTracer } from "@/lib/engine/tracing";
import { setPlan } from "@/lib/engine/state-machine";
import { saveExecutionState } from "@/lib/engine/memory";

export class GeneratePlanStep implements OrchestrationStep {
  name = "generate_plan";

  shouldExecute(context: OrchestrationContext): boolean {
    return !context.skipPlanning;
  }

  async execute(context: OrchestrationContext): Promise<OrchestrationContext> {
    if (!context.intent) {
      throw new Error("Intent not found in context");
    }

    const registryManager = getRegistryManager();
    const planResult: PlannerResult = await generatePlan(context.intent, {
      execution_id: context.executionId,
      available_tools: registryManager.listAllTools(),
    });

    // Add planning trace entry
    const tracer = createTracer(context.executionId);
    tracer.addPlanningEntry(
      { intent_type: context.intent.type },
      {
        plan_id: planResult.plan.id,
        steps: planResult.plan.steps.length,
      },
      planResult.latency_ms,
      planResult.trace_entry.model_id || "unknown",
      {
        prompt: planResult.token_usage.prompt_tokens,
        completion: planResult.token_usage.completion_tokens,
      },
    );

    // Update state with plan and persist
    let state = context.state;
    if (state) {
      state = setPlan(state, planResult.plan);
      await saveExecutionState(state);
    }

    return {
      ...context,
      plan: planResult.plan,
      state,
      correlations: {
        ...context.correlations,
        planLatencyMs: planResult.latency_ms,
        planTokenUsage: planResult.token_usage,
        stepCount: planResult.plan.steps.length,
      },
    };
  }
}
