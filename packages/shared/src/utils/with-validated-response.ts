/**
 * Validated Response Wrapper
 *
 * Provides `withValidatedResponse` - a higher-order function that automatically
 * validates API handler return values against a Zod schema before sending to the client.
 *
 * Ensures every API response conforms to the standardized response shape defined
 * in `@repo/shared/api-response`, preventing inconsistent or malformed responses.
 *
 * @package @repo/shared
 * @since 1.0.0
 *
 * @example
 * ```typescript
 * import { withValidatedResponse } from "@repo/shared/testing";
 * import { ApiSuccessResponseSchema } from "@repo/shared";
 * import { z } from "zod";
 *
 * const ReservationSchema = z.object({
 *   reservationId: z.string(),
 *   status: z.enum(["pending", "confirmed"]),
 * });
 *
 * export const GET = withValidatedResponse(
 *   ApiSuccessResponseSchema(ReservationSchema),
 *   async (req) => {
 *     const reservation = await getReservation();
 *     return { success: true, data: reservation };
 *   }
 * );
 * ```
 */

import { z } from "zod";
import { formatApiError, getErrorStatusCode } from "../utils/api-error";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Minimal Request interface to avoid depending on next/server types in shared package.
 */
interface MinimalRequest {
  url: string;
  method: string;
  headers: Headers;
  json(): Promise<unknown>;
}

/**
 * Handler function signature for validated routes.
 */
export type ValidatedHandler<TSchema extends z.ZodType> = (
  req: MinimalRequest,
) => Promise<z.infer<TSchema> | Response>;

/**
 * Options for the validated response wrapper.
 */
export interface ValidatedResponseOptions {
  /** Error code to use when validation fails (default: "INTERNAL_ERROR") */
  errorCode?: string;
  /** Log validation failures (default: true) */
  logFailures?: boolean;
}

// ============================================================================
// VALIDATED RESPONSE WRAPPER
// ============================================================================

/**
 * Wrap an API route handler with automatic response validation.
 *
 * Validates the handler's return value against the provided Zod schema.
 * If validation fails, returns a standardized 500 error response.
 *
 * This enforces that **every** API route returns data matching the
 * `ApiSuccessResponse` or `ApiErrorResponse` shape.
 *
 * @param schema - Zod schema to validate the response against
 * @param handler - Async route handler function
 * @param options - Optional configuration
 * @returns Wrapped handler with validation
 *
 * @example
 * ```typescript
 * export const GET = withValidatedResponse(
 *   ApiSuccessResponseSchema(z.object({ id: z.string() })),
 *   async (req) => {
 *     const item = await fetchItem();
 *     return { success: true, data: { id: item.id } };
 *   }
 * );
 * ```
 */
export function withValidatedResponse<TSchema extends z.ZodType>(
  schema: TSchema,
  handler: ValidatedHandler<TSchema>,
  options: ValidatedResponseOptions = {},
) {
  const { errorCode = "INTERNAL_ERROR", logFailures = true } = options;

  return async (req: MinimalRequest): Promise<Response> => {
    const result = await handler(req);

    // If handler returned a Response directly, pass it through
    if (result instanceof Response) {
      return result;
    }

    // Validate the response data against the schema
    const parseResult = schema.safeParse(result);

    if (!parseResult.success) {
      if (logFailures) {
        console.error(
          "[withValidatedResponse] Response validation failed:",
          parseResult.error.message,
          "\nExpected schema:",
          schema.description || "unknown",
          "\nReceived:",
          JSON.stringify(result, null, 2).slice(0, 500),
        );
      }

      const errorResponse = formatApiError(
        new Error(
          `Internal response validation failed: ${parseResult.error.message}`,
        ),
        errorCode as any,
      );
      const status = getErrorStatusCode(errorCode);

      return Response.json(errorResponse, { status });
    }

    // Return the validated response
    return Response.json(parseResult.data);
  };
}

// ============================================================================
// PRE-BUILT SCHEMAS FOR COMMON RESPONSE PATTERNS
// ============================================================================

/**
 * Schema for a simple success response with arbitrary data.
 */
export const SimpleSuccessSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
});

/**
 * Schema for a simple error response.
 */
export const SimpleErrorSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
});

/**
 * Schema for list responses (paginated or not).
 */
export function ListResponseSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    success: z.literal(true),
    data: z.array(itemSchema),
    count: z.number().optional(),
  });
}

/**
 * Schema for single resource responses.
 */
export function ResourceResponseSchema<T extends z.ZodType>(resourceSchema: T) {
  return z.object({
    success: z.literal(true),
    data: resourceSchema,
  });
}
