/**
 * Verify Plan Step
 *
 * Validates the generated plan against the safety policy.
 * Extracted from orchestrator.ts for better testability.
 *
 * @see Task 3: Decompose God Orchestrators
 */

import {
  OrchestrationStep,
  OrchestrationContext,
} from "../step-registry-types";
import { verifyPlan, DEFAULT_SAFETY_POLICY } from "@/lib/engine/verifier";
import { createTracer } from "@/lib/engine/tracing";
import { transitionState } from "@/lib/engine/state-machine";
import { saveExecutionState } from "@/lib/engine/memory";

export class VerifyPlanStep implements OrchestrationStep {
  name = "verify_plan";

  shouldExecute(context: OrchestrationContext): boolean {
    return !context.skipPlanning && !!context.plan;
  }

  async execute(context: OrchestrationContext): Promise<OrchestrationContext> {
    if (!context.plan) {
      throw new Error(
        "Plan not found in context. GeneratePlanStep must run first.",
      );
    }

    // Deterministic verification
    const verification = verifyPlan(context.plan, DEFAULT_SAFETY_POLICY);

    if (!verification.valid) {
      // Add trace entry
      const tracer = createTracer(context.executionId);
      tracer.addSystemEntry("plan_rejected", {
        reason: verification.reason,
        violation: verification.violation,
      });

      // Transition state to REJECTED
      if (context.state) {
        const rejectedState = transitionState(context.state, "REJECTED");
        await saveExecutionState(rejectedState);
        return { ...context, state: rejectedState };
      }

      // Throw to signal rejection (orchestrator handles the result shape)
      const error = new Error(
        verification.reason || "Plan verification failed",
      );
      (error as any).code = verification.violation || "PLAN_VALIDATION_FAILED";
      (error as any).retryable = false;
      throw error;
    }

    return {
      ...context,
      correlations: {
        ...context.correlations,
        planVerification: verification,
      },
    };
  }
}
