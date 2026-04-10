/**
 * Unified API Error Handler Wrapper
 *
 * Provides a single, consistent error handling layer for all Next.js API routes.
 * Replaces scattered try/catch + withApiErrorHandler patterns with a unified
 * higher-order function that ensures:
 *
 * - Consistent JSON error structure (ApiErrorResponse schema)
 * - Automatic OTEL/Sentry error reporting
 * - Stack trace sanitization in production
 * - Next.js special errors (redirect/notFound) preserved
 * - Trace ID extraction from request context
 *
 * Usage:
 * ```typescript
 * // Before (scattered boilerplate):
 * export const POST = withApiErrorHandler(async (req: NextRequest) => {
 *   try {
 *     // logic
 *   } catch (err) {
 *     return NextResponse.json(formatApiError(err, "EXECUTION_FAILED"), { status: 500 });
 *   }
 * }, "EXECUTION_FAILED");
 *
 * // After (unified):
 * export const POST = withUnifiedApiHandler(async (req: NextRequest) => {
 *   // logic - no try/catch needed
 * });
 * ```
 *
 * @see Task 1: Centralize API Error Handling & Standardize Responses
 */

import { NextRequest, NextResponse } from "next/server";
import { toAppError } from "../errors";
import { formatApiError, getErrorStatusCode } from "../utils/api-error";
import { Logger } from "../logger";
import { isNextRedirectError } from "../utils/next-errors";
import { getErrorMetadata, type ErrorCategory } from "../errors/http-codes";
import { tracingStorage, TRACE_ID_HEADER } from "../tracing";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Handler function signature for unified API wrapper
 */
export type UnifiedApiHandler = (
  req: NextRequest,
) => Promise<NextResponse<unknown>>;

/**
 * Configuration options for the unified API handler
 */
export interface UnifiedApiHandlerOptions {
  /** Service name for logging (defaults to 'api') */
  serviceName?: string;
  /** Include stack traces in error responses (disabled in production) */
  includeStackTrace?: boolean;
  /** Custom logger instance */
  logger?: Logger;
  /** Additional context to attach to error logs */
  errorContext?: Record<string, unknown>;
}

// ============================================================================
// UNIFIED API ERROR WRAPPER
// ============================================================================

/**
 * Wraps a Next.js API route handler with unified error handling.
 *
 * All errors caught by this wrapper are:
 * 1. Converted to AppError via toAppError()
 * 2. Logged with structured context (trace ID, status code, details)
 * 3. Formatted as standardized ApiErrorResponse
 * 4. Sanitized for production (stack traces stripped)
 * 5. Returned with correct HTTP status code
 *
 * Special Next.js errors (redirect, notFound) are re-thrown to preserve
 * navigation behavior.
 *
 * @param handler - The API route handler function
 * @param options - Optional configuration
 * @returns A Next.js route handler with unified error handling
 *
 * @example
 * ```typescript
 * // apps/intention-engine/src/app/api/chat/route.ts
 * export const POST = withUnifiedApiHandler(async (req: NextRequest) => {
 *   const body = await req.json();
 *   const result = await processChat(body);
 *   return NextResponse.json({ success: true, data: result });
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With custom options
 * export const POST = withUnifiedApiHandler(
 *   async (req: NextRequest) => { /* ... * / },
 *   { serviceName: 'checkout-api' }
 * );
 * ```
 */
export function withUnifiedApiHandler(
  handler: UnifiedApiHandler,
  options: UnifiedApiHandlerOptions = {},
): (req: NextRequest) => Promise<NextResponse<unknown>> {
  const {
    serviceName = "api",
    includeStackTrace = process.env.NODE_ENV !== "production",
    logger: customLogger,
    errorContext = {},
  } = options;

  const logger = customLogger || new Logger({ serviceName });

  return async (req: NextRequest): Promise<NextResponse<unknown>> => {
    try {
      return await handler(req);
    } catch (err) {
      // Re-throw Next.js special errors to preserve navigation
      if (isNextRedirectError(err)) {
        throw err;
      }

      // Convert to standardized AppError
      const appError = toAppError(err);

      // Extract trace ID from AsyncLocalStorage or request headers
      const store = tracingStorage.getStore();
      const traceId =
        store?.traceId ||
        req.headers.get(TRACE_ID_HEADER) ||
        (appError.details?.traceId as string) ||
        undefined;

      // Log error with full context
      logger.error({
        message: `[API Error] ${appError.message}`,
        code: appError.code,
        statusCode: appError.statusCode,
        details: appError.details,
        traceId,
        path: req.url,
        method: req.method,
        stack: includeStackTrace ? appError.stackTrace : undefined,
        ...errorContext,
      });

      // Format as standardized API error response
      const errorResponse = formatApiError(
        appError,
        appError.code as any,
        undefined,
        {
          includeStack: includeStackTrace,
          traceId,
        },
      );

      // Get correct HTTP status code
      const statusCode = getErrorStatusCode(appError.code);

      return NextResponse.json(errorResponse, { status: statusCode });
    }
  };
}

/**
 * Converts any error to a standardized AppError response.
 * Useful for manual error handling within handlers that need
 * custom logic before returning errors.
 *
 * @param error - The error to convert
 * @param defaultCode - Default error code if not determinable
 * @returns AppError instance
 */
export function toUnifiedError(
  error: unknown,
  defaultCode = "INTERNAL_ERROR",
): {
  code: string;
  message: string;
  statusCode: number;
  retryable: boolean;
  category: ErrorCategory;
  details?: unknown;
} {
  const appError = toAppError(error);
  const metadata = getErrorMetadata(appError.code as any);

  return {
    code: appError.code,
    message: appError.message,
    statusCode: appError.statusCode,
    retryable: metadata.retryable,
    category: metadata.category,
    details: appError.details,
  };
}
