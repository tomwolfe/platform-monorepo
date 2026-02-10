import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { env } from "./config";
import { Intent, IntentSchema } from "./schema";

const customOpenAI = createOpenAI({
  apiKey: env.LLM_API_KEY,
  baseURL: env.LLM_BASE_URL,
});

export interface IntentInferenceResult {
  intent: Intent;
  rawResponse: string;
}

/**
 * Infer intent from raw text.
 * Uses generateObject to ensure strict enforcement of the Intent interface.
 */
export async function inferIntent(text: string, avoidTools: string[] = []): Promise<IntentInferenceResult> {
  if (!text || text.trim().length === 0) {
    throw new Error("Input text is empty");
  }

  const avoidToolsContext = avoidTools.length > 0 
    ? `\nPREVIOUSLY FAILED TOOLS (AVOID IF POSSIBLE): ${avoidTools.join(", ")}`
    : "";

  const { object } = await generateObject({
    model: customOpenAI(env.LLM_MODEL),
    schema: IntentSchema,
    system: `Precision Intent Inference: Convert user text to JSON.
Categories: SCHEDULE, SEARCH, ACTION, QUERY, PLANNING, UNKNOWN.
Confidence < 0.7: Use 'clarification_needed' + question.
PLANNING: Use for multi-step tasks.
${avoidToolsContext}`,
    prompt: text,
  });

  // Post-process for confidence threshold (Phase 2.2)
  if (object.confidence < 0.7 && object.type !== 'clarification_needed') {
    object.type = 'clarification_needed';
    if (!object.question) {
        object.question = "I'm not quite sure what you mean. Could you please provide more details?";
    }
  }

  return {
    intent: object,
    rawResponse: JSON.stringify(object),
  };
}
