/**
 * LLM Output Validation Pipeline
 *
 * Standardizes LLM response validation using Zod schemas with automatic
 * repair retries. Replaces scattered safeParseJson + schema.safeParse
 * patterns across the intention-engine planner tools.
 *
 * Features:
 * - Automatic JSON parsing with fallback
 * - Zod schema validation
 * - Intelligent repair loop that feeds Zod errors back to LLM
 * - Configurable retry count
 * - Structured error reporting
 *
 * Usage:
 * ```typescript
 * import { validateLLMOutput, ValidationError } from '@repo/shared';
 *
 * const result = await validateLLMOutput(
 *   llmResponse,
 *   MyOutputSchema,
 *   { maxRetries: 2, modelId: 'gpt-4o' }
 * );
 * ```
 *
 * @see Task 3: Standardize LLM Output Validation Pipeline
 */

import { z } from "zod";
import { safeParseJson, sanitizeJsonOutput } from "../utils/json-parser";
import { Logger } from "../logger";

const logger = new Logger({ serviceName: "llm-validation" });

// ============================================================================
// TYPES
// ============================================================================

/**
 * Error thrown when LLM output fails validation after retries
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Configuration for LLM output validation
 */
export interface LLMValidationOptions<T = unknown> {
  /** Maximum number of repair attempts (default: 1) */
  maxRetries?: number;
  /** Model ID for logging context */
  modelId?: string;
  /** System prompt to use for repair (optional) */
  repairSystemPrompt?: string;
  /** Custom logger */
  logger?: Logger;
  /** LLM invocation function for repair attempts */
  repairFn?: (
    originalResponse: string,
    schema: z.ZodType<T>,
    errors: string,
  ) => Promise<string>;
}

/**
 * Result of a validation attempt
 */
export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: string[];
  attempts: number;
}

// ============================================================================
// REPAIR PROMPT GENERATOR
// ============================================================================

/**
 * Generate a repair prompt that includes the original response, schema expectations,
 * and specific validation errors.
 *
 * @param originalResponse - The original LLM response that failed validation
 * @param schemaDescription - Human-readable description of expected output
 * @param errors - Zod validation errors
 * @returns Repair prompt for the LLM
 */
function generateRepairPrompt(
  originalResponse: string,
  schemaDescription: string,
  errors: string,
): string {
  return `Your previous response failed validation. Please fix the issues below.

## Original Response
\`\`\`json
${originalResponse}
\`\`\`

## Expected Schema
${schemaDescription}

## Validation Errors
${errors}

## Instructions
1. Return ONLY valid JSON matching the schema above
2. Do NOT include markdown code blocks or explanations
3. Fix ALL listed errors
4. Ensure all required fields are present

Return the corrected JSON only:`;
}

/**
 * Generate a human-readable schema description from a Zod schema
 */
function describeSchema<T>(schema: z.ZodType<T>): string {
  try {
    // Try to get schema shape if it's an object schema
    if ("shape" in schema && typeof schema.shape === "object") {
      const shape = schema.shape as Record<string, z.ZodTypeAny>;
      const fields = Object.entries(shape).map(([key, value]) => {
        const typeName = value._def?.typeName || "unknown";
        const isOptional = value._def?.typeName === "ZodOptional";
        return `  - ${key}: ${typeName}${isOptional ? " (optional)" : ""}`;
      });
      return `Object with fields:\n${fields.join("\n")}`;
    }
    return schema._def?.typeName || "Unknown schema";
  } catch {
    return "Complex schema (unable to describe)";
  }
}

/**
 * Create an LLM-based repair function for use with parseJsonWithFallback.
 * This decouples the heavy AI SDK dependencies from the generic JSON parser.
 */
export function createLlmRepairFn(options: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}) {
  const {
    apiKey = process.env.LLM_API_KEY,
    baseUrl = process.env.LLM_BASE_URL,
    model = process.env.LLM_MODEL || "gpt-4o-mini",
  } = options;

  return async function repairJson(
    malformedJson: string,
    schemaDescription?: string,
  ): Promise<string | null> {
    if (!apiKey) return null;

    try {
      const { generateText } = await import("ai");
      const { createOpenAI } = await import("@ai-sdk/openai");

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
${malformedJson.substring(0, 2000)}
`;

      const { text } = await generateText({
        model: openai(model),
        prompt,
        maxTokens: 1000,
        temperature: 0.1,
      });

      const repaired = sanitizeJsonOutput(text);
      JSON.parse(repaired);
      return repaired;
    } catch {
      return null;
    }
  };
}

// ============================================================================
// MAIN VALIDATION FUNCTION
// ============================================================================

/**
 * Validate LLM output against a Zod schema with automatic repair retries.
 *
 * This function:
 * 1. Parses the response as JSON
 * 2. Validates against the schema
 * 3. If validation fails, generates a repair prompt and retries
 * 4. Throws ValidationError if all retries exhausted
 *
 * @param response - Raw LLM response string
 * @param schema - Zod schema to validate against
 * @param options - Validation configuration
 * @returns Validated and typed data
 * @throws ValidationError if validation fails after all retries
 *
 * @example
 * ```typescript
 * const plan = await validateLLMOutput(
 *   llmResponse,
 *   PlanSchema,
 *   { maxRetries: 2, modelId: 'gpt-4o' }
 * );
 * ```
 */
export async function validateLLMOutput<T>(
  response: string,
  schema: z.ZodType<T>,
  options: LLMValidationOptions<T> = {},
): Promise<T> {
  const {
    maxRetries = 1,
    modelId,
    repairSystemPrompt,
    logger: customLogger,
    repairFn,
  } = options;

  const validationLogger = customLogger || logger;
  let parsed: unknown;
  let attempt = 0;
  let lastResponse = response;

  while (attempt <= maxRetries) {
    // Step 1: Parse JSON
    try {
      parsed = safeParseJson(lastResponse);
    } catch (parseError) {
      validationLogger.warn({
        message: `[LLM Validation] JSON parse failed (attempt ${attempt + 1})`,
        modelId,
        error:
          parseError instanceof Error ? parseError.message : String(parseError),
        response: lastResponse.substring(0, 500),
      });

      if (attempt >= maxRetries) {
        throw new ValidationError(
          `LLM output failed JSON parsing after ${maxRetries + 1} attempts`,
          "LLM_JSON_PARSE_FAILED",
          { modelId, attempts: attempt + 1 },
        );
      }

      attempt++;
      continue;
    }

    // Step 2: Validate against schema
    const result = schema.safeParse(parsed);

    if (result.success) {
      // Validation succeeded
      if (attempt > 0) {
        validationLogger.info({
          message: `[LLM Validation] Validation succeeded after repair (attempt ${attempt + 1})`,
          modelId,
        });
      }
      return result.data;
    }

    // Validation failed
    const errorMessages = result.error.errors.map((e) => {
      const path = e.path.length > 0 ? ` at '${e.path.join(".")}'` : "";
      return `${e.message}${path}`;
    });

    validationLogger.warn({
      message: `[LLM Validation] Validation failed (attempt ${attempt + 1})`,
      modelId,
      errors: errorMessages,
      response: lastResponse.substring(0, 500),
    });

    if (attempt >= maxRetries) {
      throw new ValidationError(
        `LLM output failed validation after ${maxRetries + 1} attempts: ${errorMessages.join("; ")}`,
        "LLM_VALIDATION_FAILED",
        {
          modelId,
          errors: errorMessages,
          attempts: attempt + 1,
          response: lastResponse.substring(0, 1000),
        },
      );
    }

    // Step 3: Attempt repair
    attempt++;

    try {
      if (repairFn) {
        // Use custom repair function if provided
        lastResponse = await repairFn(
          lastResponse,
          schema,
          errorMessages.join("\n"),
        );
      } else {
        // Default: use built-in repair prompt
        // Note: In production, this would call the LLM with the repair prompt.
        // For now, we throw validation error since we don't have LLM access here.
        // The calling code should provide repairFn for actual LLM invocation.
        validationLogger.info({
          message: `[LLM Validation] Repair attempt ${attempt}/${maxRetries} - repairFn not provided, skipping`,
          modelId,
        });
        continue;
      }

      validationLogger.info({
        message: `[LLM Validation] Repair attempt ${attempt}/${maxRetries}`,
        modelId,
        errors: errorMessages,
      });
    } catch (repairError) {
      validationLogger.error({
        message: `[LLM Validation] Repair failed (attempt ${attempt})`,
        modelId,
        error:
          repairError instanceof Error
            ? repairError.message
            : String(repairError),
      });
      // Continue to next attempt if repair fails
    }
  }

  throw new ValidationError(
    "LLM output failed validation after all retries",
    "LLM_VALIDATION_FAILED",
    { modelId, attempts: attempt },
  );
}

/**
 * Synchronous validation without repair loop.
 * Useful for validating already-parsed LLM outputs or cached responses.
 *
 * @param data - Parsed data to validate
 * @param schema - Zod schema to validate against
 * @returns Validated and typed data
 * @throws ValidationError if validation fails
 */
export function validateLLMOutputSync<T>(
  data: unknown,
  schema: z.ZodType<T>,
): T {
  const result = schema.safeParse(data);

  if (result.success) {
    return result.data;
  }

  const errorMessages = result.error.errors.map((e) => {
    const path = e.path.length > 0 ? ` at '${e.path.join(".")}'` : "";
    return `${e.message}${path}`;
  });

  throw new ValidationError(
    `LLM output failed validation: ${errorMessages.join("; ")}`,
    "LLM_VALIDATION_FAILED",
    { errors: errorMessages },
  );
}

/**
 * Safe parse JSON with fallback error handling.
 * Extracts JSON from markdown code blocks and handles parsing errors.
 *
 * @param input - Raw string input
 * @returns Parsed JSON object
 * @throws Error if parsing fails
 */
export function parseJsonSafely(input: string): unknown {
  return safeParseJson(input);
}
