/**
 * Parse Intent Step
 *
 * Pure function that parses user input into a structured intent.
 * Extracted from orchestrator.ts for better testability.
 *
 * @see Task 3: Decompose God Orchestrators
 */

import { OrchestrationStep, OrchestrationContext } from "./step-registry-types";
import { parseIntent, ParseResult } from "@/lib/engine/intent";
import { createTracer } from "@/lib/engine/tracing";

export class ParseIntentStep implements OrchestrationStep {
  name = "parse_intent";

  async execute(context: OrchestrationContext): Promise<OrchestrationContext> {
    const parseResult: ParseResult = await parseIntent(context.input, {
      execution_id: context.executionId,
      user_context: context.userContext,
    });

    // Add intent trace entry
    const tracer = createTracer(context.executionId);
    tracer.addIntentEntry(
      context.input,
      parseResult.intent,
      parseResult.latency_ms,
      parseResult.intent.metadata.model_id || "unknown",
      {
        prompt: parseResult.token_usage.prompt_tokens,
        completion: parseResult.token_usage.completion_tokens,
      },
    );

    return {
      ...context,
      intent: parseResult.intent,
      correlations: {
        ...context.correlations,
        parseLatencyMs: parseResult.latency_ms,
        tokenUsage: parseResult.token_usage,
      },
    };
  }
}
