/**
 * JSON Parsing Utilities for LLM Output
 *
 * Provides robust JSON parsing with markdown stripping and fallback strategies.
 * LLMs often wrap JSON in markdown code blocks or add explanatory text.
 *
 * @package @repo/shared
 * @since 1.0.0
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface JsonParseResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  sanitizedContent: string;
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
  if (sanitized.startsWith('{') || sanitized.startsWith('[')) {
    return sanitized;
  }

  // Prefer regex-based balanced bracket extraction over indexOf fallback
  // Handles nested objects/arrays without breaking on conversational curly braces
  const jsonObjectMatch = sanitized.match(/\{(?:[^{}]|(?:\{[^{}]*\}))*\}/);
  const jsonArrayMatch = sanitized.match(/\[(?:[^\[\]]|(?:\[[^\[\]]*\]))*\]/);

  if (jsonObjectMatch) {
    try {
      JSON.parse(jsonObjectMatch[0]);
      return jsonObjectMatch[0];
    } catch (e) {
      // Fall through if invalid
    }
  }

  if (jsonArrayMatch) {
    try {
      JSON.parse(jsonArrayMatch[0]);
      return jsonArrayMatch[0];
    } catch (e) {
      // Fall through if invalid
    }
  }

  // Absolute last resort: keep the existing indexOf fallback
  const jsonStartIndex = sanitized.indexOf('{');
  const jsonEndIndex = sanitized.lastIndexOf('}');

  if (jsonStartIndex !== -1 && jsonEndIndex !== -1 && jsonEndIndex > jsonStartIndex) {
    return sanitized.substring(jsonStartIndex, jsonEndIndex + 1);
  }

  // Try to find JSON array
  const arrayStartIndex = sanitized.indexOf('[');
  const arrayEndIndex = sanitized.lastIndexOf(']');

  if (arrayStartIndex !== -1 && arrayEndIndex !== -1 && arrayEndIndex > arrayStartIndex) {
    return sanitized.substring(arrayStartIndex, arrayEndIndex + 1);
  }

  // Return original if no JSON structure found
  return sanitized;
}

/**
 * Parse JSON with robust error handling and sanitization.
 * Attempts multiple strategies before failing.
 *
 * @param content - Raw LLM output
 * @returns Parsed JSON object
 * @throws Error if JSON cannot be parsed
 */
export function parseJsonWithFallback<T = any>(content: string): T {
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
        // Fall through to original error
      }
    }

    // Throw with helpful error message including sanitized content preview
    const preview = sanitized.substring(0, 200) + (sanitized.length > 200 ? '...' : '');
    const error = new Error(
      `Failed to parse JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}\n\n` +
      `Content preview: ${preview}`
    );
    (error as any).code = 'JSON_PARSE_ERROR';
    (error as any).originalContent = content;
    (error as any).sanitizedContent = sanitized;
    throw error;
  }
}

/**
 * Safe JSON parsing that returns a result object instead of throwing.
 *
 * @param content - Raw LLM output
 * @returns Parse result with success flag
 */
export function safeParseJson<T = any>(content: string): JsonParseResult<T> {
  try {
    const data = parseJsonWithFallback<T>(content);
    const sanitized = sanitizeJsonOutput(content);
    return {
      success: true,
      data,
      sanitizedContent: sanitized,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      sanitizedContent: sanitizeJsonOutput(content),
    };
  }
}
