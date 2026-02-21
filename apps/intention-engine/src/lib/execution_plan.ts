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
    const toolName = intent.parameters.capability || intent.parameters.tool_name;
    const parameters = { ...(intent.parameters.arguments as any || intent.parameters) };

    // Standardize time fields for booking
    if (toolName === "book_restaurant_table") {
      if (parameters.start_time && !parameters.time) {
        parameters.time = parameters.start_time;
      }
      if (parameters.reservation_time && !parameters.time) {
        parameters.time = parameters.reservation_time;
      }
    }

    steps.push({
      id: crypto.randomUUID(),
      step_number: steps.length,
      tool_name: toolName,
      tool_version: "1.0.0",
      parameters: parameters,
      dependencies: [],
      requires_confirmation: guardrail.requiresConfirmation,
      timeout_ms: 30000,
      description: guardrail.reason || `Execute ${toolName}`
    });
  } else if (intent.type === "SCHEDULE") {
    const isDinner = intent.rawText.toLowerCase().includes("dinner") || 
                     (intent.parameters.title && intent.parameters.title.toLowerCase().includes("dinner"));

    if (isDinner) {
      // Special logic for dinner: add route estimate
      steps.push({
        id: crypto.randomUUID(),
        step_number: steps.length,
        tool_name: "get_route_estimate",
        tool_version: "1.0.0",
        parameters: {
          origin: "current_location",
          destination: intent.parameters.location || intent.parameters.restaurant_address || "the restaurant",
          travel_mode: "driving"
        },
        dependencies: [],
        requires_confirmation: false,
        timeout_ms: 30000,
        description: "Calculate travel time for dinner"
      });
    }

    steps.push({
      id: crypto.randomUUID(),
      step_number: steps.length,
      tool_name: "add_calendar_event",
      tool_version: "1.0.0",
      parameters: {
        events: [{
          title: intent.parameters.title || "New Event",
          start_time: intent.parameters.start_time || intent.parameters.temporal_expression,
          end_time: intent.parameters.end_time,
          location: intent.parameters.location || intent.parameters.restaurant_address,
          restaurant_name: intent.parameters.restaurant_name
        }]
      },
      dependencies: [],
      requires_confirmation: guardrail.requiresConfirmation,
      timeout_ms: 30000,
      description: isDinner ? "Schedule dinner and adjust for travel" : "Schedule event"
    });
  }

  // Transactional intents (high risk) trigger total confirmation
  const isTransactional = steps.some(s => 
    ["request_ride", "book_restaurant_table"].includes(s.tool_name)
  );

  return {
    intent_id: intent.id,
    steps,
    requires_total_confirmation: guardrail.requiresConfirmation || isTransactional,
    dry_run: dryRun
  };
}
