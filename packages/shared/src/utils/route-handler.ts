/**
 * Route Handler Factory
 *
 * Provides a standardized wrapper for API route handlers that enforces:
 * - Zod validation
 * - Auth context extraction
 * - Consistent error formatting
 * - Response serialization
 *
 * Usage:
 * ```typescript
 * export const POST = createRouteHandler(
 *   ReserveRequestSchema,
 *   async (data, ctx) => {
 *     const result = await reservationService.create(data, ctx);
 *     return { status: 201, body: { message: 'Created', bookingId: result.id } };
 *   }
 * );
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { formatApiError, formatApiSuccess } from "../utils/api-error";
import type { ErrorCode } from "../errors";

// ============================================================================
// REQUEST CONTEXT
// ============================================================================

/**
 * Request context extracted after authentication
 */
export interface RequestContext {
  /** Authenticated user/restaurant ID */
  resourceId?: string;
  /** Whether this is an internal service-to-service call */
  isInternal?: boolean;
  /** Trace ID from request headers */
  traceId?: string;
  /** Scoped permissions (if JWT has tool-level permissions) */
  scopedPermissions?: Record<string, unknown>;
  /** Raw auth context from middleware */
  authContext?: Record<string, unknown>;
}

// ============================================================================
// HANDLER TYPES
// ============================================================================

/**
 * Route handler response
 */
export interface RouteHandlerResponse<T = unknown> {
  status?: number;
  headers?: Record<string, string>;
  body: T;
}

/**
 * Route handler function type
 */
export type RouteHandlerFn<TInput, TOutput> = (
  data: TInput,
  ctx: RequestContext,
  req: NextRequest,
) => Promise<RouteHandlerResponse<TOutput>>;

/**
 * Options for createRouteHandler
 */
export interface RouteHandlerOptions {
  /** Default error code if handler throws */
  defaultErrorCode?: ErrorCode;
  /** Service name for logging */
  serviceName?: string;
  /** Custom auth validator function */
  authValidator?: (
    req: NextRequest,
  ) => Promise<{ error?: string; status?: number; context?: RequestContext }>;
  /** Whether to require idempotency key */
  requireIdempotency?: boolean;
}

// ============================================================================
// ROUTE HANDLER FACTORY
// ============================================================================

/**
 * Create a standardized POST route handler
 *
 * @param schema - Zod schema for request validation
 * @param handler - Business logic handler function
 * @param options - Handler configuration options
 * @returns Next.js route handler function
 *
 * @example
 * ```typescript
 * export const POST = createRouteHandler(
 *   ReserveRequestSchema,
 *   async (data, ctx) => {
 *     const result = await reservationService.create(data, ctx);
 *     return { status: 201, body: { message: 'Created', bookingId: result.id } };
 *   },
 *   { serviceName: 'reserve-api', requireIdempotency: true }
 * );
 * ```
 */
export function createRouteHandler<
  TSchema extends z.ZodType,
  TOutput extends Record<string, unknown>,
>(
  schema: TSchema,
  handler: RouteHandlerFn<z.infer<TSchema>, TOutput>,
  options: RouteHandlerOptions = {},
): (req: NextRequest) => Promise<NextResponse> {
  const {
    defaultErrorCode = "EXECUTION_FAILED",
    serviceName = "api",
    authValidator,
    requireIdempotency = false,
  } = options;

  return async (req: NextRequest) => {
    const traceId =
      req.headers.get("x-trace-id") ||
      req.headers.get("x-correlation-id") ||
      undefined;

    try {
      // Step 1: Auth validation
      if (authValidator) {
        const authResult = await authValidator(req);
        if (authResult?.error) {
          return NextResponse.json(
            formatApiError(new Error(authResult.error), "UNAUTHORIZED", {
              traceId,
            }),
            { status: authResult.status || 401 },
          );
        }
      }

      // Step 2: Idempotency check (if required)
      if (requireIdempotency) {
        const idempotencyKey = req.headers.get("x-idempotency-key");
        if (!idempotencyKey) {
          return NextResponse.json(
            formatApiError(
              new Error("Idempotency key is required"),
              "VALIDATION_ERROR",
              undefined,
              { traceId },
            ),
            { status: 400 },
          );
        }
      }

      // Step 3: Parse and validate body
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return NextResponse.json(
          formatApiError(
            new Error("Invalid JSON in request body"),
            "VALIDATION_ERROR",
            undefined,
            { traceId },
          ),
          { status: 400 },
        );
      }

      const validation = schema.safeParse(body);
      if (!validation.success) {
        return NextResponse.json(
          formatApiError(
            new Error(validation.error.message),
            "VALIDATION_ERROR",
            {
              fields: validation.error.flatten().fieldErrors,
            },
            { traceId },
          ),
          { status: 400 },
        );
      }

      // Step 4: Build request context
      const ctx: RequestContext = {
        traceId,
      };

      // Step 5: Call handler
      const result = await handler(validation.data, ctx, req);

      // Step 6: Format response
      const response = NextResponse.json(
        formatApiSuccess(result.body, { traceId }),
        {
          status: result.status || 200,
        },
      );

      // Add custom headers
      if (result.headers) {
        Object.entries(result.headers).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
      }

      return response;
    } catch (error) {
      // Handler threw an error - let the outer error handler catch it
      const appError =
        error instanceof Error ? error : new Error(String(error));
      (appError as any).details = {
        ...(appError as any).details,
        traceId,
        serviceName,
      };
      throw appError;
    }
  };
}
