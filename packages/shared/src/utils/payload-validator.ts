/**
 * Payload Validator
 *
 * Validates payloads at async boundaries (QStash webhooks, Ably message handlers,
 * external webhooks) using Zod schemas to prevent type safety leaks.
 *
 * This eliminates unsafe `as any` casts and ensures all external data is validated
 * before being processed by internal services.
 *
 * Usage:
 * ```typescript
 * // At QStash webhook ingress point
 * const payload = validatePayload(WebhookEventSchema, req.body);
 *
 * // At Ably message handler
 * const event = validatePayload(AblyEventSchema, message.data);
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";
import { ValidationError } from "../errors";

/**
 * Custom error for payload validation failures
 * Provides detailed error messages for debugging
 */
export class PayloadValidationError extends ValidationError {
  public readonly schemaErrors: string[];

  constructor(message: string, schemaErrors: string[] = []) {
    super(message, { schemaErrors });
    this.name = "PayloadValidationError";
    this.schemaErrors = schemaErrors;
  }
}

/**
 * Validates and transforms unknown payload using Zod schema
 *
 * At async boundaries (webhooks, message queues, pub/sub), data arrives as
 * untyped JSON. This function validates it against a schema and returns
 * properly typed data, or throws a structured validation error.
 *
 * @param schema - Zod schema to validate against
 * @param data - Unknown payload data (typically from req.body or message.data)
 * @returns Validated and typed data
 * @throws PayloadValidationError if validation fails
 *
 * @example
 * ```typescript
 * const QStashMessageSchema = z.object({
 *   executionId: z.string().uuid(),
 *   stepIndex: z.number().int().min(0),
 *   traceId: z.string().optional(),
 * });
 *
 * // In webhook handler
 * const payload = validatePayload(QStashMessageSchema, req.body);
 * // payload is now typed as z.infer<typeof QStashMessageSchema>
 * ```
 */
export function validatePayload<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    const errors = result.error.errors.map((err) => {
      const path = err.path.join(".");
      return path ? `${path}: ${err.message}` : err.message;
    });

    throw new PayloadValidationError(
      `Payload validation failed: ${errors.join("; ")}`,
      errors,
    );
  }

  return result.data;
}

/**
 * Validates payload with optional fallback
 *
 * Like validatePayload, but returns a default value if validation fails
 * instead of throwing. Useful for optional fields with sensible defaults.
 *
 * @param schema - Zod schema to validate against
 * @param data - Unknown payload data
 * @param defaultValue - Default value if validation fails
 * @returns Validated data or default value
 *
 * @example
 * ```typescript
 * const config = validatePayloadOptional(ConfigSchema, body.config, DEFAULT_CONFIG);
 * ```
 */
export function validatePayloadOptional<T>(
  schema: z.ZodType<T>,
  data: unknown,
  defaultValue: T,
): T {
  const result = schema.safeParse(data);

  if (!result.success) {
    return defaultValue;
  }

  return result.data;
}

/**
 * Creates a validated payload handler function
 *
 * Factory function that creates reusable validators for specific schemas.
 * Useful for creating boundary-specific validators at module scope.
 *
 * @param schema - Zod schema to validate against
 * @returns Function that validates unknown data against the schema
 *
 * @example
 * ```typescript
 * const validateWebhookEvent = createValidator(WebhookEventSchema);
 *
 * // Later in handler
 * const event = validateWebhookEvent(req.body);
 * ```
 */
export function createValidator<T>(schema: z.ZodType<T>): (data: unknown) => T {
  return (data: unknown) => validatePayload(schema, data);
}

/**
 * Safe JSON parser with validation
 *
 * Parses JSON string and validates against a schema in one step.
 * Prevents the common pattern of JSON.parse followed by unsafe casts.
 *
 * @param jsonString - JSON string to parse and validate
 * @param schema - Zod schema to validate against
 * @returns Validated and typed data
 * @throws PayloadValidationError if parsing or validation fails
 */
export function parseAndValidateJson<T>(
  jsonString: string,
  schema: z.ZodType<T>,
): T {
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonString);
  } catch (error) {
    throw new PayloadValidationError(
      "Invalid JSON format",
      error instanceof Error ? [error.message] : ["Unknown JSON parse error"],
    );
  }

  return validatePayload(schema, parsed);
}
