/**
 * IntentionEngine - Intent Parser
 * Phase 3: Parse user input into structured, validated Intent
 *
 * Constraints:
 * - No planning logic
 * - No execution logic
 * - No Redis calls
 * - Uses classification model for parsing
 * - Appends trace entry
 */

import { z } from "zod";
import { randomUUID, createHash } from "crypto";
import {
  Intent,
  IntentSchema,
  IntentType,
  IntentTypeSchema,
  IntentMetadataSchema,
  TraceEntry,
  TraceEntrySchema,
  EngineErrorSchema,
} from "./types";
import { generateStructured, GenerateStructuredResult } from "./llm";
import { Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "intention-engine" });

// ============================================================================
// CONFIDENCE THRESHOLD & FALLBACK CONFIGURATION
// T1.2: LLM Confidence Fallback & Rule-Based Routing
// ============================================================================

/**
 * Minimum confidence threshold for accepting LLM intent classification.
 * If confidence drops below this value, the system falls back to
 * deterministic keyword matching to prevent silent failures.
 */
export const INTENT_CONFIDENCE_THRESHOLD = 0.65;

/**
 * Keyword-to-intent mapping for deterministic fallback routing.
 * Ordered by priority — earlier matches take precedence.
 */
const KEYWORD_INTENT_MAP: Record<string, IntentType> = {
  // SCHEDULE keywords
  schedule: "SCHEDULE",
  meeting: "SCHEDULE",
  calendar: "SCHEDULE",
  appointment: "SCHEDULE",
  remind: "SCHEDULE",
  "set up": "SCHEDULE",

  // BOOKING keywords
  book: "ACTION",
  booking: "ACTION",
  reserve: "ACTION",
  reservation: "ACTION",
  table: "ACTION",
  restaurant: "ACTION",
  order: "ACTION",

  // DELIVERY keywords
  deliver: "ACTION",
  delivery: "ACTION",
  shipping: "ACTION",
  track: "QUERY",
  status: "QUERY",

  // SEARCH keywords
  find: "SEARCH",
  search: "SEARCH",
  look: "SEARCH",
  discover: "SEARCH",

  // QUERY keywords
  what: "QUERY",
  when: "QUERY",
  where: "QUERY",
  how: "QUERY",
  weather: "QUERY",
  who: "QUERY",
  why: "QUERY",

  // PLANNING keywords
  plan: "PLANNING",
  trip: "PLANNING",
  itinerary: "PLANNING",
  organize: "PLANNING",

  // ANALYSIS keywords
  analyze: "ANALYSIS",
  compare: "ANALYSIS",
  summary: "ANALYSIS",
  evaluate: "ANALYSIS",
  review: "ANALYSIS",
};

/**
 * Fallback intent types for specialized scenarios
 */
const FALLBACK_KEYWORDS: Record<string, IntentType> = {
  help: "QUERY",
  cancel: "ACTION",
  stop: "ACTION",
  hello: "QUERY",
  hi: "QUERY",
  hey: "QUERY",
  thanks: "QUERY",
  thank: "QUERY",
};

// ============================================================================
// METRICS TRACKING
// T1.2: Track fallback events for monitoring
// ============================================================================

/**
 * Counter for LLM fallback triggers.
 * Incremented each time the system falls back to rule-based routing.
 * Should be exported to OpenTelemetry in production.
 */
let llmFallbackTriggerCount = 0;

/**
 * Get the current LLM fallback trigger count.
 * Used for monitoring and alerting.
 */
export function getLLMFallbackCount(): number {
  return llmFallbackTriggerCount;
}

/**
 * Reset the fallback counter (for testing).
 */
export function resetLLMFallbackCount(): void {
  llmFallbackTriggerCount = 0;
}

/**
 * Record a fallback event for monitoring.
 * Logs the event and increments the counter.
 */
function recordFallbackEvent(
  reason: "low_confidence" | "llm_error" | "llm_5xx" | "llm_timeout",
  originalInput: string,
  confidence?: number,
): void {
  llmFallbackTriggerCount++;

  logger.warn(`[T1.2] LLM fallback triggered — routing to rule-based intent`, {
    reason,
    confidence,
    input_preview: originalInput.slice(0, 100),
    fallback_count: llmFallbackTriggerCount,
    metric: "llm_fallback_triggered",
    timestamp: new Date().toISOString(),
  });

  // In production, this would emit to OpenTelemetry:
  // metrics.counter('llm_fallback_triggered', { reason }).add(1);
}

// ============================================================================
// INTENT HASHING
// Deterministic hashing for immutable intent linking
// ============================================================================

/**
 * Deterministic keyword-based intent classification.
 * Used as a fallback when LLM confidence is too low or the service is unavailable.
 *
 * @param input - User input text
 * @returns Classified intent type
 */
export function classifyIntentByKeywords(input: string): {
  type: IntentType;
  confidence: number;
} {
  const normalizedInput = input.toLowerCase().trim();
  const words = normalizedInput.split(/\s+/);

  // Check multi-word keywords first (higher priority)
  for (const [keyword, intentType] of Object.entries(KEYWORD_INTENT_MAP)) {
    if (keyword.includes(" ") && normalizedInput.includes(keyword)) {
      return { type: intentType, confidence: 0.7 };
    }
  }

  // Check single-word keywords
  const matchedKeywords: Array<{ keyword: string; intentType: IntentType }> =
    [];

  for (const [keyword, intentType] of Object.entries(KEYWORD_INTENT_MAP)) {
    if (!keyword.includes(" ") && words.includes(keyword)) {
      matchedKeywords.push({ keyword, intentType });
    }
  }

  // Check fallback keywords
  for (const [keyword, intentType] of Object.entries(FALLBACK_KEYWORDS)) {
    if (words.includes(keyword)) {
      matchedKeywords.push({ keyword, intentType });
    }
  }

  if (matchedKeywords.length === 0) {
    return { type: "UNKNOWN", confidence: 0.3 };
  }

  // Use the most common intent type among matched keywords
  const intentCounts: Record<string, number> = {};
  for (const { intentType } of matchedKeywords) {
    intentCounts[intentType] = (intentCounts[intentType] || 0) + 1;
  }

  const firstMatch = matchedKeywords[0];
  let bestIntent: IntentType = firstMatch!.intentType;
  let bestCount = 0;

  for (const [intentType, count] of Object.entries(intentCounts)) {
    if (count > bestCount) {
      bestCount = count;
      bestIntent = intentType as IntentType;
    }
  }

  // Confidence scales with number of matching keywords (max 0.85)
  const keywordConfidence = Math.min(0.5 + matchedKeywords.length * 0.1, 0.85);

  return { type: bestIntent, confidence: keywordConfidence };
}

/**
 * Extract parameters from user input using basic pattern matching.
 * Used as a fallback when LLM parameter extraction is unavailable.
 */
function extractParametersByKeywords(input: string): Record<string, unknown> {
  const normalizedInput = input.toLowerCase();
  const params: Record<string, unknown> = {};

  // Extract time patterns (e.g., "at 2pm", "at 14:00")
  const timeMatch = normalizedInput.match(
    /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
  );
  if (timeMatch) {
    params.time = timeMatch[1];
  }

  // Extract date patterns (e.g., "tomorrow", "next Monday", "Jan 15")
  const datePatterns = [
    { pattern: /\b(tomorrow|today|tonight)\b/i, key: "date" },
    {
      pattern:
        /\b(next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i,
      key: "date",
    },
    { pattern: /\b(\w+\s+\d{1,2}(?:st|nd|rd|th)?)\b/i, key: "date" },
  ];

  for (const { pattern, key } of datePatterns) {
    const match = normalizedInput.match(pattern);
    if (match && !params[key]) {
      params[key] = match[1];
    }
  }

  // Extract numbers (e.g., party size, quantity)
  const numberMatch = normalizedInput.match(
    /\b(for\s+)?(\d{1,2})\s*(?:people|persons?|pax|guests?)?\b/i,
  );
  if (numberMatch && numberMatch[2]) {
    params.party_size = parseInt(numberMatch[2], 10);
  }

  // Extract quoted strings as named entities
  const quotedMatch = input.match(/"([^"]+)"/);
  if (quotedMatch && quotedMatch[1]) {
    params.query = quotedMatch[1];
  }

  return params;
}

/**
 * Generates a deterministic SHA-256 hash for an intent.
 * Sorts parameters alphabetically to ensure "A and B" == "B and A".
 */
export function generateIntentHash(
  type: string,
  parameters: Record<string, unknown>,
): string {
  const sortedParams: Record<string, unknown> = {};
  const keys = Object.keys(parameters).sort();

  for (const key of keys) {
    sortedParams[key] = parameters[key];
  }

  const payload = JSON.stringify({
    type,
    parameters: sortedParams,
  });

  return createHash("sha256").update(payload).digest("hex");
}

// ============================================================================
// PARSED INTENT SCHEMA (LLM Output)
// Schema for the raw LLM classification output
// ============================================================================

const ParsedIntentSchema = z.object({
  type: IntentTypeSchema,
  confidence: z.number().min(0).max(1),
  parameters: z.record(z.string(), z.unknown()),
  explanation: z.string(),
  requires_clarification: z.boolean(),
  clarification_prompt: z.string().optional(),
});

export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;

// ============================================================================
// PARSER CONTEXT
// Context passed to parser for classification
// ============================================================================

export interface ParseContext {
  execution_id?: string;
  user_context?: Record<string, unknown>;
  previous_intents?: Intent[];
  available_intent_types?: IntentType[];
}

// ============================================================================
// PARSER RESULT
// Result of intent parsing operation
// ============================================================================

export interface ParseResult {
  intent: Intent;
  trace_entry: TraceEntry;
  latency_ms: number;
  token_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ============================================================================
// SYSTEM PROMPT
// Instructions for the classification model
// ============================================================================

const INTENT_CLASSIFICATION_PROMPT = `You are an intent classification system. Your job is to analyze user input and classify it into a structured intent.

## Available Intent Types
- SCHEDULE: Calendar-only operations, such as scheduling meetings, adding events, or checking availability.
- SEARCH: Finding information, looking up data, searching for items (e.g., restaurants, locations).
- ACTION: External tool execution or real-world actions, such as booking a restaurant table, requesting a ride, or sending a message.
- QUERY: Asking for specific information or data retrieval (e.g., weather, status, facts).
- PLANNING: Multi-step planning, trip planning, project planning, or requests involving both searching and booking.
- ANALYSIS: Data analysis, summarization, comparison, evaluation.
- UNKNOWN: Only use this if the input is complete gibberish or has no discernible intent.
- CLARIFICATION_REQUIRED: Intent is ambiguous or missing critical information (e.g., "Schedule it" without saying what or when).

## Confidence Guidelines
- 0.9-1.0: Very clear, unambiguous intent
- 0.7-0.89: Clear intent with minor ambiguity
- 0.5-0.69: Moderate confidence, some ambiguity present
- 0.3-0.49: Low confidence, significant ambiguity
- 0.0-0.29: Very unclear, likely UNKNOWN or CLARIFICATION_REQUIRED

## Multi-Entity Handling (CRITICAL)
If the user provides a list of entities for a single request (e.g., multiple cities, people, or items), you MUST:
1. Identify the primary intent (e.g., QUERY for weather).
2. Extract ALL entities into an array for the appropriate parameter.
3. NEVER fallback to UNKNOWN just because there are multiple entities.
4. Ensure the confidence remains HIGH if the request is otherwise clear.

## Output Requirements
1. Always provide a confidence score between 0 and 1. If a partial match is found, DO NOT default to 0; provide an appropriate partial confidence score.
2. Extract relevant parameters from the user input (dates, names, locations, etc.)
3. If a parameter contains multiple distinct entities (e.g., "Tokyo, London, and NY"), return them as an array of entities for that parameter.
4. Provide a clear explanation of why this intent was chosen
5. Set requires_clarification to true if the user needs to provide more information
6. If clarification is needed, provide a specific prompt asking for the missing information

## Examples
Input: "Schedule a meeting with John tomorrow at 2pm"
Output: {
  "type": "SCHEDULE",
  "confidence": 0.95,
  "parameters": {
    "action": "create_meeting",
    "participants": ["John"],
    "date": "tomorrow",
    "time": "2pm"
  },
  "explanation": "User wants to create a calendar event with a specific person at a specific time",
  "requires_clarification": false
}

Input: "Find a romantic Italian restaurant for tonight at 7 PM and book a table for 2"
Output: {
  "type": "PLANNING",
  "confidence": 0.98,
  "parameters": {
    "cuisine": "Italian",
    "atmosphere": "romantic",
    "date": "tonight",
    "time": "7 PM",
    "party_size": 2
  },
  "explanation": "User request involves searching for a restaurant and booking it, which requires a multi-step plan",
  "requires_clarification": false
}

Input: "What is the weather in Tokyo, London, and New York?"
Output: {
  "type": "QUERY",
  "confidence": 0.98,
  "parameters": {
    "location": ["Tokyo", "London", "New York"]
  },
  "explanation": "User is asking for weather information for multiple locations",
  "requires_clarification": false
}

Input: "Find me a good restaurant"
Output: {
  "type": "SEARCH",
  "confidence": 0.75,
  "parameters": {
    "category": "restaurant",
    "criteria": "good"
  },
  "explanation": "User wants to search for restaurants, but 'good' is subjective and location is not specified",
  "requires_clarification": true,
  "clarification_prompt": "What type of cuisine are you looking for, and what area or neighborhood?"
}`;

// ============================================================================
// PARSE INTENT
// Main entry point: parses user input into validated Intent
// ============================================================================

export async function parseIntent(
  input: string,
  context: ParseContext = {},
): Promise<ParseResult> {
  const startTime = performance.now();
  const timestamp = new Date().toISOString();

  try {
    // Validate input
    if (!input || typeof input !== "string" || input.trim().length === 0) {
      throw EngineErrorSchema.parse({
        code: "INTENT_PARSE_FAILED",
        message: "Invalid input: empty or non-string input provided",
        details: { input_type: typeof input },
        recoverable: false,
        timestamp,
      });
    }

    // Use LLM to classify intent
    let generationResult: GenerateStructuredResult<ParsedIntent>;
    try {
      generationResult = await generateStructured({
        modelType: "classification",
        prompt: input,
        systemPrompt: INTENT_CLASSIFICATION_PROMPT,
        schema: ParsedIntentSchema,
        temperature: 0.1, // Low temperature for deterministic classification
        timeoutMs: 15000, // 15 second timeout for parsing
      });
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        (error.message.includes("timeout") ||
          error.message.includes("deadline"));

      // Check if this might be a 5xx error pattern
      const isServerError =
        error instanceof Error &&
        (error.message.includes("5") ||
          error.message.includes("internal server") ||
          error.message.includes("service unavailable"));

      const fallbackReason = isTimeout
        ? ("llm_timeout" as const)
        : isServerError
          ? ("llm_5xx" as const)
          : ("llm_error" as const);

      logger.warn(
        `[Intent Engine] Structured generation failed (${isTimeout ? "TIMEOUT" : "ERROR"}), falling back to rule-based classification`,
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );

      recordFallbackEvent(fallbackReason, input);

      // Fall back to deterministic keyword matching
      const keywordResult = classifyIntentByKeywords(input);
      const fallbackParams = extractParametersByKeywords(input);

      // Build a fallback intent using rule-based classification
      const fallbackParsedIntent: ParsedIntent = {
        type: keywordResult.type,
        confidence: keywordResult.confidence,
        parameters: fallbackParams,
        explanation: isTimeout
          ? `The intent parsing service timed out. Switching to rule-based classification (detected: ${keywordResult.type}).`
          : `The intent parsing service encountered an error. Switching to rule-based classification (detected: ${keywordResult.type}).`,
        requires_clarification: keywordResult.type === "UNKNOWN",
        clarification_prompt:
          keywordResult.type === "UNKNOWN"
            ? "I'm having some trouble processing your request right now. Could you please try again or simplify your request?"
            : undefined,
      };

      const intent: Intent = IntentSchema.parse({
        id: randomUUID(),
        type: fallbackParsedIntent.type,
        confidence: fallbackParsedIntent.confidence,
        parameters: fallbackParsedIntent.parameters,
        rawText: input.trim(),
        explanation: fallbackParsedIntent.explanation,
        hash: generateIntentHash(
          fallbackParsedIntent.type,
          fallbackParsedIntent.parameters,
        ),
        metadata: IntentMetadataSchema.parse({
          version: "1.0.0",
          timestamp,
          source: "rule_based_fallback",
          fallback_reason: fallbackReason,
        }),
        requires_clarification: fallbackParsedIntent.requires_clarification,
        clarification_prompt: fallbackParsedIntent.clarification_prompt,
      });

      const endTime = performance.now();
      const latencyMs = Math.round(endTime - startTime);

      const traceEntry: TraceEntry = TraceEntrySchema.parse({
        timestamp,
        phase: "intent",
        event: "intent_parse_fallback_error",
        input: { rawText: input.trim(), context },
        output: intent,
        latency_ms: latencyMs,
        token_usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });

      return {
        intent,
        trace_entry: traceEntry,
        latency_ms: latencyMs,
        token_usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      };
    }

    const parsedIntent = generationResult.data;
    const llmResponse = generationResult.response;

    // ============================================================================
    // T1.2: CONFIDENCE THRESHOLD CHECK
    // If LLM confidence is below threshold, fall back to rule-based routing
    // ============================================================================
    if (parsedIntent.confidence < INTENT_CONFIDENCE_THRESHOLD) {
      recordFallbackEvent("low_confidence", input, parsedIntent.confidence);

      // Fall back to deterministic keyword matching
      const keywordResult = classifyIntentByKeywords(input);
      const fallbackParams = extractParametersByKeywords(input);

      const fallbackParsedIntent: ParsedIntent = {
        type: keywordResult.type,
        confidence: keywordResult.confidence,
        parameters: fallbackParams,
        explanation: `LLM confidence (${parsedIntent.confidence}) below threshold (${INTENT_CONFIDENCE_THRESHOLD}). Falling back to rule-based keyword classification.`,
        requires_clarification: keywordResult.type === "UNKNOWN",
        clarification_prompt:
          keywordResult.type === "UNKNOWN"
            ? "I'm having trouble understanding your request. Could you please rephrase it?"
            : undefined,
      };

      const intent: Intent = IntentSchema.parse({
        id: randomUUID(),
        type: fallbackParsedIntent.type,
        confidence: fallbackParsedIntent.confidence,
        parameters: fallbackParsedIntent.parameters,
        rawText: input.trim(),
        explanation: fallbackParsedIntent.explanation,
        hash: generateIntentHash(
          fallbackParsedIntent.type,
          fallbackParsedIntent.parameters,
        ),
        metadata: IntentMetadataSchema.parse({
          version: "1.0.0",
          timestamp,
          source: "rule_based_fallback",
          model_id: llmResponse.model_id,
          execution_id: context.execution_id,
          fallback_reason: "low_confidence",
          original_llm_confidence: parsedIntent.confidence,
        }),
        requires_clarification: fallbackParsedIntent.requires_clarification,
        clarification_prompt: fallbackParsedIntent.clarification_prompt,
      });

      const endTime = performance.now();
      const latencyMs = Math.round(endTime - startTime);

      const traceEntry: TraceEntry = TraceEntrySchema.parse({
        timestamp,
        phase: "intent",
        event: "intent_parse_fallback_keyword",
        input: { rawText: input.trim(), context },
        output: intent,
        latency_ms: latencyMs,
        token_usage: {
          prompt_tokens: llmResponse.token_usage.prompt_tokens,
          completion_tokens: llmResponse.token_usage.completion_tokens,
          total_tokens: llmResponse.token_usage.total_tokens,
        },
      });

      return {
        intent,
        trace_entry: traceEntry,
        latency_ms: latencyMs,
        token_usage: {
          prompt_tokens: llmResponse.token_usage.prompt_tokens,
          completion_tokens: llmResponse.token_usage.completion_tokens,
          total_tokens: llmResponse.token_usage.total_tokens,
        },
      };
    }

    // Build the canonical Intent
    const intent: Intent = IntentSchema.parse({
      id: randomUUID(),
      type: parsedIntent.type,
      confidence: parsedIntent.confidence,
      parameters: parsedIntent.parameters,
      rawText: input.trim(),
      explanation: parsedIntent.explanation,
      hash: generateIntentHash(parsedIntent.type, parsedIntent.parameters),
      metadata: IntentMetadataSchema.parse({
        version: "1.0.0",
        timestamp,
        source: "user_input",
        model_id: llmResponse.model_id,
        execution_id: context.execution_id,
      }),
      requires_clarification: parsedIntent.requires_clarification,
      clarification_prompt: parsedIntent.clarification_prompt,
    });

    const endTime = performance.now();
    const latencyMs = Math.round(endTime - startTime);

    // Create trace entry
    const traceEntry: TraceEntry = TraceEntrySchema.parse({
      timestamp,
      phase: "intent",
      event: "intent_parsed",
      input: { rawText: input.trim(), context },
      output: intent,
      latency_ms: latencyMs,
      model_id: llmResponse.model_id,
      token_usage: {
        prompt_tokens: llmResponse.token_usage.prompt_tokens,
        completion_tokens: llmResponse.token_usage.completion_tokens,
        total_tokens: llmResponse.token_usage.total_tokens,
      },
    });

    return {
      intent,
      trace_entry: traceEntry,
      latency_ms: latencyMs,
      token_usage: {
        prompt_tokens: llmResponse.token_usage.prompt_tokens,
        completion_tokens: llmResponse.token_usage.completion_tokens,
        total_tokens: llmResponse.token_usage.total_tokens,
      },
    };
  } catch (error) {
    const endTime = performance.now();
    const latencyMs = Math.round(endTime - startTime);

    // If it's already an EngineError, re-throw it
    if (error && typeof error === "object" && "code" in error) {
      throw error;
    }

    // Wrap unexpected errors
    const errorMessage = error instanceof Error ? error.message : String(error);

    throw EngineErrorSchema.parse({
      code: "INTENT_PARSE_FAILED",
      message: `Intent parsing failed: ${errorMessage}`,
      details: {
        input: input.slice(0, 100), // Truncate for safety
        latency_ms: latencyMs,
      },
      recoverable: false,
      timestamp,
    });
  }
}

// ============================================================================
// VALIDATE INTENT CONFIDENCE
// Helper to check if intent confidence meets threshold
// ============================================================================

export const CONFIDENCE_THRESHOLDS = {
  HIGH: 0.9,
  MEDIUM: 0.7,
  LOW: 0.5,
  MINIMUM: 0.3,
} as const;

export function validateIntentConfidence(
  intent: Intent,
  minimumThreshold: number = CONFIDENCE_THRESHOLDS.MINIMUM,
): { valid: boolean; reason?: string } {
  if (intent.confidence < minimumThreshold) {
    return {
      valid: false,
      reason: `Intent confidence ${intent.confidence} is below threshold ${minimumThreshold}`,
    };
  }

  if (intent.requires_clarification) {
    return {
      valid: false,
      reason: `Intent requires clarification: ${intent.clarification_prompt || "No clarification prompt provided"}`,
    };
  }

  if (intent.type === "UNKNOWN") {
    return {
      valid: false,
      reason: "Intent type is UNKNOWN",
    };
  }

  if (intent.type === "CLARIFICATION_REQUIRED") {
    return {
      valid: false,
      reason: `Clarification required: ${intent.clarification_prompt || "No clarification prompt provided"}`,
    };
  }

  return { valid: true };
}

// ============================================================================
// BATCH PARSE (for testing/validation)
// Parse multiple inputs in sequence
// ============================================================================

export async function parseIntentBatch(
  inputs: string[],
  context: ParseContext = {},
): Promise<ParseResult[]> {
  const results: ParseResult[] = [];

  for (const input of inputs) {
    const result = await parseIntent(input, context);
    results.push(result);
  }

  return results;
}

/**
 * Validates tool output against user's qualitative constraints.
 * Returns a match score (0-1) and whether it's considered valid.
 */
export async function validateOutputAgainstConstraints(
  output: unknown,
  constraints: string[],
): Promise<{ score: number; valid: boolean; reason?: string }> {
  if (!constraints || constraints.length === 0)
    return { score: 1, valid: true };

  const outputString = JSON.stringify(output).toLowerCase();
  let matches = 0;

  for (const constraint of constraints) {
    if (outputString.includes(constraint.toLowerCase())) {
      matches++;
    }
  }

  const heuristicScore = matches / constraints.length;

  // If heuristic is low or ambiguous, use LLM for semantic validation
  if (heuristicScore < 0.8) {
    try {
      const prompt = `Analyze if the tool output satisfies the user's qualitative constraints.
Output Data: ${JSON.stringify(output)}
Constraints: ${constraints.join(", ")}

Respond with a JSON object: {"score": number (0-1), "explanation": string}`;

      const validationResult = await generateStructured({
        modelType: "classification",
        prompt,
        systemPrompt:
          "You are a high-precision semantic validation system. Verify if the provided entity data matches the user's qualitative adjectives (e.g. 'romantic', 'cheap', 'nearby').",
        schema: z.object({ score: z.number(), explanation: z.string() }),
      });

      return {
        score: validationResult.data.score,
        valid: validationResult.data.score >= 0.7,
        reason: validationResult.data.explanation,
      };
    } catch (e) {
      logger.warn(`Semantic validation failed, falling back to heuristic`, {
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        score: heuristicScore,
        valid: heuristicScore >= 0.5,
        reason: "Heuristic validation applied",
      };
    }
  }

  return { score: heuristicScore, valid: true };
}

// ============================================================================
// BACKWARD COMPATIBILITY WRAPPER
// inferIntent legacy API for existing callers
// ============================================================================

export interface IntentInferenceResult {
  hypotheses: {
    primary: Intent;
    alternatives: Intent[];
    isAmbiguous: boolean;
  };
  rawResponse: string;
}

/**
 * Backward-compatible wrapper for legacy inferIntent API.
 * Maps parseIntent result to the legacy IntentInferenceResult structure.
 *
 * AI-03: Confidence-Based Clarification Routing
 * - If intent.confidence < 0.6, automatically sets status to CLARIFICATION_REQUIRED
 * - Injects clarification_prompt from predefined fallback list if not provided
 */
export async function inferIntent(
  text: string,
  avoidTools: string[] = [],
  history: Intent[] = [],
  lastContext?: {
    intentType?: string;
    rawText?: string;
    parameters?: Record<string, unknown>;
  },
  clerkId?: string,
): Promise<IntentInferenceResult> {
  // Note: avoidTools, history, lastContext, and clerkId are ignored in this wrapper
  // as the new parseIntent doesn't use them. Future enhancement: integrate these.
  const parseResult = await parseIntent(text);

  let intent = parseResult.intent;

  // AI-03: Confidence-Based Clarification Routing
  if (intent.confidence < 0.6 && intent.type !== "CLARIFICATION_REQUIRED") {
    logger.info(
      "[AI-03] Low confidence intent detected, routing to clarification",
      {
        confidence: intent.confidence,
        intentType: intent.type,
      },
    );

    // Override to CLARIFICATION_REQUIRED status
    intent = {
      ...intent,
      type: "CLARIFICATION_REQUIRED" as any,
      requires_clarification: true,
      clarification_prompt:
        intent.clarification_prompt ||
        generateFallbackClarificationPrompt(text),
      metadata: intent.metadata || {
        version: "1.0.0",
        timestamp: new Date().toISOString(),
        source: "clarification_routing",
      },
      explanation: `${intent.explanation || ""} [AI-03: Confidence below 0.6 threshold, clarification required]`,
    };
  }

  return {
    hypotheses: {
      primary: intent,
      alternatives: [],
      isAmbiguous: intent.requires_clarification || intent.confidence < 0.6,
    },
    rawResponse: JSON.stringify(intent),
  };
}

// ============================================================================
// AI-03: FALLBACK CLARIFICATION PROMPTS
// Predefined clarification prompts for low-confidence intents
// ============================================================================

const FALLBACK_CLARIFICATION_PROMPTS = [
  "Could you please provide more details about what you'd like to do?",
  "I want to make sure I understand correctly. Can you clarify your request?",
  "Could you specify more details so I can help you better?",
  "I'm not entirely sure I understood. Could you rephrase or add more context?",
];

let fallbackPromptIndex = 0;

/**
 * Generate a fallback clarification prompt when the LLM doesn't provide one.
 * Rotates through predefined prompts to avoid repetition.
 */
function generateFallbackClarificationPrompt(originalInput: string): string {
  const prompt =
    FALLBACK_CLARIFICATION_PROMPTS[
      fallbackPromptIndex % FALLBACK_CLARIFICATION_PROMPTS.length
    ] ||
    FALLBACK_CLARIFICATION_PROMPTS[0] ||
    "Could you please provide more details about what you'd like to do?";
  fallbackPromptIndex++;
  return prompt;
}
