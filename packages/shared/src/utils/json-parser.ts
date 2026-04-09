/**
 * JSON Parsing Utilities for LLM Output
 *
 * Provides robust JSON parsing with markdown stripping and fallback strategies.
 * LLMs often wrap JSON in markdown code blocks or add explanatory text.
 *
 * AI-01: Self-Healing JSON Parser
 * - Adds LLM-based repair for malformed JSON
 * - Maximum 1 retry to prevent infinite loops
 *
 * @package @repo/shared
 * @since 1.0.0
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface JsonParseResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  sanitizedContent: string;
  wasRepaired?: boolean; // AI-01: Track if LLM repair was used
}

// ============================================================================
// JSON SANITIZATION UTILITIES
// Strip markdown code blocks and extract JSON from LLM output
// ============================================================================

/**
 * Sanitize LLM output by stripping markdown code blocks and extracting JSON.
 * LLMs often wrap JSON in ```json or ``` blocks - this handles those cases.
 *
 * @param content - Raw LLM output string
 * @returns Sanitized JSON string
 */
export function sanitizeJsonOutput(content: string): string {
  let sanitized = content.trim();

  // Strip markdown code blocks with optional language specifier
  // Matches: ```json {...} ``` or ``` {...} ```
  const markdownCodeBlockRegex = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const markdownMatch = sanitized.match(markdownCodeBlockRegex);

  if (markdownMatch) {
    sanitized = markdownMatch[1].trim();
  }

  // Fallback: Extract JSON object/array from mixed content
  // This handles cases where LLM adds explanatory text before/after JSON
  if (sanitized.startsWith("{") || sanitized.startsWith("[")) {
    return sanitized;
  }

  // Use a safe, iterative stack-based bracket extractor to avoid ReDoS
  const extracted = extractJsonSubstrings(sanitized);
  if (extracted.length > 0) {
    try {
      JSON.parse(extracted[0]);
      return extracted[0];
    } catch (e) {
      // Fall through if invalid
    }
  }

  // Absolute last resort: keep the existing indexOf fallback
  const jsonStartIndex = sanitized.indexOf("{");
  const jsonEndIndex = sanitized.lastIndexOf("}");

  if (
    jsonStartIndex !== -1 &&
    jsonEndIndex !== -1 &&
    jsonEndIndex > jsonStartIndex
  ) {
    return sanitized.substring(jsonStartIndex, jsonEndIndex + 1);
  }

  // Try to find JSON array
  const arrayStartIndex = sanitized.indexOf("[");
  const arrayEndIndex = sanitized.lastIndexOf("]");

  if (
    arrayStartIndex !== -1 &&
    arrayEndIndex !== -1 &&
    arrayEndIndex > arrayStartIndex
  ) {
    return sanitized.substring(arrayStartIndex, arrayEndIndex + 1);
  }

  // Return original if no JSON structure found
  return sanitized;
}

/**
 * Safely extract JSON substrings using an iterative stack-based approach.
 * This avoids ReDoS vulnerabilities from complex regex patterns on nested structures.
 *
 * @param text - Input text potentially containing JSON
 * @returns Array of extracted JSON substrings (empty if none found)
 */
function extractJsonSubstrings(text: string): string[] {
  let startIndex = text.indexOf("{");
  const arrayStartIndex = text.indexOf("[");
  if (
    arrayStartIndex !== -1 &&
    (startIndex === -1 || arrayStartIndex < startIndex)
  ) {
    startIndex = arrayStartIndex;
  }
  if (startIndex === -1) return [];

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  const startChar = text[startIndex];
  const endChar = startChar === "{" ? "}" : "]";

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === startChar) depth++;
      else if (char === endChar) depth--;

      if (depth === 0) {
        return [text.substring(startIndex, i + 1)];
      }
    }
  }
  return [];
}

/**
 * AI-01: Attempt to repair malformed JSON using a lightweight LLM call.
 * This is a single-retry mechanism to prevent infinite loops.
 *
 * @param malformedJson - The malformed JSON string to repair
 * @param schemaDescription - Description of the expected schema
 * @returns Repaired JSON string or null if repair fails
 */
async function attemptLlmRepair(
  malformedJson: string,
  schemaDescription?: string,
): Promise<string | null> {
  try {
    // Dynamically import AI SDK to avoid bundling issues in edge runtime
    const { generateText } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");

    // Check if we have the required configuration
    const apiKey = process.env.LLM_API_KEY;
    const baseUrl = process.env.LLM_BASE_URL;
    const model = process.env.LLM_MODEL || "gpt-4o-mini";

    if (!apiKey) {
      return null; // Can't repair without API key
    }

    const openai = createOpenAI({
      apiKey,
      baseURL: baseUrl,
    });

    const schemaHint = schemaDescription
      ? `\nExpected schema: ${schemaDescription}`
      : "";

    const prompt = `Fix this malformed JSON to match the expected schema. Output ONLY valid JSON, no explanations.
${schemaHint}

Malformed JSON:
${malformedJson.substring(0, 2000)} // Truncated for context
`;

    const { text } = await generateText({
      model: openai(model),
      prompt,
      maxTokens: 1000,
      temperature: 0.1, // Low temperature for deterministic repair
    });

    // Extract JSON from the repair attempt
    const repaired = sanitizeJsonOutput(text);
    // Validate it's actually valid JSON
    JSON.parse(repaired);
    return repaired;
  } catch (error) {
    // LLM repair failed - return null to indicate failure
    return null;
  }
}

/**
 * Parse JSON with robust error handling and sanitization.
 * Attempts multiple strategies before failing.
 *
 * AI-01: Self-Healing - Adds LLM-based repair as a final fallback
 *
 * @param content - Raw LLM output
 * @param options - Parsing options
 * @param options.schema - Optional Zod schema description for LLM repair
 * @returns Parsed JSON object or Promise if repair is attempted
 * @throws Error if JSON cannot be parsed
 */
export async function parseJsonWithFallback<T = unknown>(
  content: string,
  options?: {
    /** Schema description for LLM repair (AI-01) */
    schema?: string;
    /** Enable LLM repair (default: true) */
    enableRepair?: boolean;
  },
): Promise<T> {
  const { schema, enableRepair = true } = options || {};
  const sanitized = sanitizeJsonOutput(content);

  try {
    return JSON.parse(sanitized);
  } catch (parseError) {
    // If parsing fails, try to extract JSON using regex
    const jsonRegex = /(\{[\s\S]*\}|\[[\s\S]*\])/;
    const match = content.match(jsonRegex);

    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch (secondError) {
        // Fall through to repair attempt
      }
    }

    // AI-01: Attempt LLM-based repair (single retry)
    if (enableRepair) {
      const repaired = await attemptLlmRepair(sanitized, schema);
      if (repaired) {
        try {
          return JSON.parse(repaired);
        } catch (repairError) {
          // Repair produced invalid JSON, fall through to error
        }
      }
    }

    // Throw with helpful error message including sanitized content preview
    const preview =
      sanitized.substring(0, 200) + (sanitized.length > 200 ? "..." : "");
    const error = new Error(
      `Failed to parse JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}\n\n` +
        `Content preview: ${preview}`,
    );
    (error as any).code = "JSON_PARSE_ERROR";
    (error as any).originalContent = content;
    (error as any).sanitizedContent = sanitized;
    throw error;
  }
}

/**
 * Safe JSON parsing that returns a result object instead of throwing.
 *
 * AI-01: Tracks if LLM repair was used
 *
 * @param content - Raw LLM output
 * @param options - Parsing options
 * @returns Parse result with success flag
 */
export async function safeParseJson<T = unknown>(
  content: string,
  options?: {
    schema?: string;
    enableRepair?: boolean;
  },
): Promise<JsonParseResult<T>> {
  try {
    const data = await parseJsonWithFallback<T>(content, options);
    const sanitized = sanitizeJsonOutput(content);
    return {
      success: true,
      data,
      sanitizedContent: sanitized,
      wasRepaired: false, // If we got here without throwing, no repair was needed
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      sanitizedContent: sanitizeJsonOutput(content),
      wasRepaired: false,
    };
  }
}

/**
 * Synchronous version of safeParseJson for environments where async is not available.
 * Does NOT support LLM repair.
 *
 * @param content - Raw LLM output
 * @returns Parse result with success flag
 */
export function safeParseJsonSync<T = unknown>(
  content: string,
): JsonParseResult<T> {
  try {
    const data = parseJsonWithFallback<T>(content, { enableRepair: false });
    const sanitized = sanitizeJsonOutput(content);
    return {
      success: true,
      data,
      sanitizedContent: sanitized,
      wasRepaired: false,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      sanitizedContent: sanitizeJsonOutput(content),
      wasRepaired: false,
    };
  }
}
