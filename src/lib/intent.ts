import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { env } from "./config";
import { Intent, IntentSchema } from "./schema";
import { normalizeIntent } from "./normalization";
import { resolveAmbiguity, IntentHypotheses } from "./ambiguity";

const customOpenAI = createOpenAI({
  apiKey: env.LLM_API_KEY,
  baseURL: env.LLM_BASE_URL,
});

export interface IntentInferenceResult {
  hypotheses: IntentHypotheses;
  rawResponse: string;
}

const CandidateSchema = IntentSchema.omit({ id: true, metadata: true, rawText: true });

/**
 * Infer intent from raw text with ambiguity detection.
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
    schema: z.object({
      candidates: z.array(CandidateSchema).min(1).max(3),
    }),
    system: `Precision Intent Inference. 
Generate 1-3 possible interpretations if the request is ambiguous.
Categories: SCHEDULE, SEARCH, ACTION, QUERY, PLANNING, ANALYSIS.
Rules:
- SCHEDULE: Needs 'action' and 'temporal_expression'.
- SEARCH: Needs 'query' and 'scope'.
- ACTION: Needs 'capability' and 'arguments'.
- QUERY: Needs 'target_object'.
- PLANNING: Needs 'goal'.
- ANALYSIS: Needs 'context'.
Refuse illegal requests by setting type to 'REFUSED'.
Confidence must reflect certainty. If ambiguous, provide multiple candidates with lower confidence.
${avoidToolsContext}`,
    prompt: text,
  });

  const normalizedIntents = object.candidates.map(c => normalizeIntent(c, text, env.LLM_MODEL));
  const hypotheses = resolveAmbiguity(normalizedIntents);

  return {
    hypotheses,
    rawResponse: JSON.stringify(object),
  };
}
