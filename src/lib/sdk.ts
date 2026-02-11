import { inferIntent } from "./intent";
import { createExecutionPlan, ExecutionPlan } from "./execution_plan";
import { IntentHypotheses } from "./ambiguity";

export interface IntentionEngineResponse {
  hypotheses: IntentHypotheses;
  plan?: ExecutionPlan;
  audit_log_id?: string;
}

/**
 * IntentionEngine SDK
 * Use this to integrate the engine into your application.
 */
export class IntentionEngine {
  /**
   * Processes a user request and returns inferred intents and a potential execution plan.
   */
  static async process(text: string): Promise<IntentionEngineResponse> {
    const { hypotheses } = await inferIntent(text);
    
    let plan: ExecutionPlan | undefined;
    
    // Only generate a plan if the primary intent is confident and unambiguous
    if (!hypotheses.isAmbiguous && hypotheses.primary.confidence > 0.8) {
      try {
        plan = createExecutionPlan(hypotheses.primary, true); // Default to dry-run
      } catch (e) {
        console.warn("Could not generate execution plan:", e);
      }
    }

    return {
      hypotheses,
      plan,
    };
  }
}
