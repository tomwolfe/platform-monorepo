import { generateObject } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { env } from "./config";
import { IntentSchema } from "./schema";
import type { Intent } from "./schema";
import { normalizeIntent } from "./normalization";
import { resolveAmbiguity } from "./ambiguity";
import type { IntentHypotheses } from "./ambiguity";

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
export async function inferIntent(
  text: string, 
  avoidTools: string[] = [],
  history: Intent[] = []
): Promise<IntentInferenceResult> {
  if (!text || text.trim().length === 0) {
    throw new Error("Input text is empty");
  }

  const avoidToolsContext = avoidTools.length > 0 
    ? `\nPREVIOUSLY FAILED TOOLS (AVOID IF POSSIBLE): ${avoidTools.join(", ")}`
    : "";

  const historyContext = history.length > 0
    ? `\n\n### RECENT HISTORY (Last ${history.length} successful intents):
${history.map((h, i) => `${i+1}. TYPE: ${h.type} | PARAMS: ${JSON.stringify(h.parameters)} | TEXT: "${h.rawText}"`).join("\n")}
Use this history to resolve pronouns ("it", "then", "there") or to understand the context of a follow-up request.`
    : "";

  const { object } = await generateObject({
    model: customOpenAI(env.LLM_MODEL),
    schema: z.object({
      candidates: z.array(CandidateSchema).min(1).max(3),
    }),
    system: `### ROLE: Semantic Normalization Architect
Objective: Eliminate LLM Jitter. Map user input to exactly ONE of the 6 core Intent Types with 100% repeatability.

### CORE ONTOLOGY
1. SCHEDULE: Temporal events (meetings, reminders, bookings, syncs).
2. SEARCH: Information retrieval from external sources.
3. ACTION: Direct side-effects, mutations, or tool executions.
4. QUERY: Internal state lookups or data checks.
5. PLANNING: Multi-step strategy or complex goal decomposition.
6. ANALYSIS: Synthesis, reasoning, or summarization over context.

### NORMALIZATION PROTOCOL
- VERB COLLAPSING: Map all synonyms to their ontological root.
- DETERMINISTIC PARAMETERS: Use standard keys (e.g., 'time', 'topic', 'target', 'query'). ISO 8601 for dates.
- CoT VERIFICATION: You MUST use the 'explanation' field for a Chain-of-Thought analysis:
  1. IDENTIFY: Literal action.
  2. MAP: Semantic root to Ontology.
  3. EXTRACT: Entities into standard keys.
  4. VALIDATE: Ensure required parameters are present.

### CONTEXTUAL RESOLUTION (MEMORY)
- Resolve pronouns ("it", "them", "that") using the RECENT HISTORY provided.
- If the user says "do it", refer to the most recent ACTION or SCHEDULE.
- If the user says "where is it", refer to the target of the most recent SEARCH or QUERY.${historyContext}

### "BOOK IT" DEFENSE
- Assign confidence based on semantic clarity and parameter completeness.
- CONFIDENCE < 0.85: If the intent is ambiguous or critical parameters are missing, you MUST lower confidence below 0.85 to trigger a RESOLVE_AMBIGUITY event.

SCHEMA_INVARIANCE: Only use the defined IntentType enum.${avoidToolsContext}`,
    prompt: text,
  });

  const normalizedIntents = object.candidates.map(c => normalizeIntent(c, text, env.LLM_MODEL));
  const hypotheses = resolveAmbiguity(normalizedIntents);

  return {
    hypotheses,
    rawResponse: JSON.stringify(object),
  };
}
