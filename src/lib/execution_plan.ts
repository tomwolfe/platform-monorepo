import { Intent, Step } from "./schema";
import { checkGuardrails } from "./guardrails";

export interface ExecutionPlan {
  intent_id: string;
  steps: Step[];
  requires_total_confirmation: boolean;
  dry_run: boolean;
}

/**
 * Transforms a validated Intent into a structured Execution Plan.
 */
export function createExecutionPlan(intent: Intent, dryRun: boolean = true): ExecutionPlan {
  const guardrail = checkGuardrails(intent);

  if (!guardrail.allowed) {
    throw new Error(`Execution blocked by guardrails: ${guardrail.reason}`);
  }

  const steps: Step[] = [];

  // Mapping logic based on Intent Type
  if (intent.type === "ACTION") {
    steps.push({
      tool_name: intent.parameters.capability,
      parameters: intent.parameters.arguments || {},
      requires_confirmation: guardrail.requiresConfirmation,
      description: guardrail.reason || "Execute action"
    });
  } else if (intent.type === "SCHEDULE") {
    steps.push({
      tool_name: "calendar.create",
      parameters: {
        title: intent.parameters.title || "New Event",
        time: intent.parameters.temporal_expression
      },
      requires_confirmation: false,
      description: "Schedule event"
    });
  }

  return {
    intent_id: intent.id,
    steps,
    requires_total_confirmation: guardrail.requiresConfirmation,
    dry_run: dryRun
  };
}
