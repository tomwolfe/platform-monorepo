/**
 * JSON Parsing Utilities for LLM Output
 *
 * Provides robust JSON parsing with markdown stripping and fallback strategies.
 * LLMs often wrap JSON in markdown code blocks or add explanatory text.
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { Logger } from "../logger";
import {
  AppError,
  ErrorCode,
  ValidationError as _ValidationError,
} from "../errors";

const jsonLogger = new Logger({ serviceName: "json-parser" });

// ============================================================================
// JSON PARSE ERROR
// ============================================================================

/**
 * Error thrown when JSON parsing fails
 */
export class JsonParseError extends AppError {
  public readonly originalContent: string;
  public readonly sanitizedContent: string;

  constructor(
    message: string,
    originalContent: string,
    sanitizedContent: string,
  ) {
    super(ErrorCode.INVALID_FORMAT, message, 400, {
      originalContentPreview: originalContent.substring(0, 200),
      sanitizedContentPreview: sanitizedContent.substring(0, 200),
    });
    this.name = "JsonParseError";
    this.originalContent = originalContent;
    this.sanitizedContent = sanitizedContent;
  }
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface JsonParseResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  sanitizedContent: string;
  wasRepaired?: boolean;
}

export interface JsonParseOptions {
  /** Schema description passed to repairFn */
  schema?: string;
  /** Custom repair function for malformed JSON */
  repairFn?: (json: string, schema?: string) => Promise<string | null>;
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
    } catch {
      // Fall through if invalid — not an error, just control flow
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
 * Parse JSON with robust error handling and sanitization.
 * Attempts multiple strategies before failing.
 *
 * @param content - Raw LLM output
 * @param options - Parsing options
 * @param options.schema - Optional schema description for repair
 * @param options.repairFn - Custom repair function (required for LLM repair)
 * @returns Parsed JSON object or Promise if repair is attempted
 * @throws Error if JSON cannot be parsed
 */
export async function parseJsonWithFallback<T = unknown>(
  content: string,
  options?: JsonParseOptions,
): Promise<T> {
  const { schema, repairFn } = options || {};
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
      } catch {
        // Fall through to repair attempt
      }
    }

    // Attempt repair if a repairFn is provided
    if (repairFn) {
      const repaired = await repairFn(sanitized, schema);
      if (repaired) {
        try {
          return JSON.parse(repaired);
        } catch (repairError) {
          jsonLogger.warn({
            message: "[JSON Parser] Repair function produced invalid JSON",
            error:
              repairError instanceof Error
                ? repairError.message
                : String(repairError),
          });
          // Repair produced invalid JSON, fall through to error
        }
      }
    }

    // Throw with helpful error message including sanitized content preview
    const preview =
      sanitized.substring(0, 200) + (sanitized.length > 200 ? "..." : "");
    throw new JsonParseError(
      `Failed to parse JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}\n\nContent preview: ${preview}`,
      content,
      sanitized,
    );
  }
}

/**
 * Safe JSON parsing that returns a result object instead of throwing.
 *
 * @param content - Raw LLM output
 * @param options - Parsing options
 * @returns Parse result with success flag
 */
export async function safeParseJson<T = unknown>(
  content: string,
  options?: JsonParseOptions,
): Promise<JsonParseResult<T>> {
  try {
    const data = await parseJsonWithFallback<T>(content, options);
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

/**
 * Synchronous version of safeParseJson for environments where async is not available.
 * Does NOT support repair.
 *
 * @param content - Raw LLM output
 * @returns Parse result with success flag
 */
export function safeParseJsonSync<T = unknown>(
  content: string,
): JsonParseResult<T> {
  try {
    const data = parseJsonWithFallback<T>(content, { repairFn: undefined });
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
