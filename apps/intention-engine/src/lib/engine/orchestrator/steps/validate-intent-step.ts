/**
 * Validate Intent Step
 *
 * Pure function that validates parsed intent confidence and structure.
 * Extracted from orchestrator.ts for better testability.
 *
 * @see Task 3: Decompose God Orchestrators
 */

import {
  OrchestrationStep,
  OrchestrationContext,
  StepResult,
} from "./step-registry-types";
import {
  validateIntentConfidence,
  IntentValidationResult,
} from "@/lib/engine/intent";

export class ValidateIntentStep implements OrchestrationStep {
  name = "validate_intent";

  async execute(context: OrchestrationContext): Promise<OrchestrationContext> {
    if (!context.intent) {
      throw new Error(
        "Intent not found in context. ParseIntentStep must run first.",
      );
    }

    const validation: IntentValidationResult = validateIntentConfidence(
      context.intent,
    );

    if (!validation.valid) {
      // Throw to trigger rollback
      const error = new Error(validation.reason || "Intent validation failed");
      (error as any).code = "INTENT_VALIDATION_FAILED";
      (error as any).retryable = false;
      throw error;
    }

    return {
      ...context,
      correlations: {
        ...context.correlations,
        intentValidation: validation,
      },
    };
  }
}
