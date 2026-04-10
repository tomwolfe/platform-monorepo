/**
 * Unified API Handler Wrapper
 *
 * Single entry point for all Next.js API routes. Provides:
 * - Automatic error catching and formatting
 * - Consistent response shape (Zod-validated)
 * - Trace ID injection
 * - Observability hooks
 * - Request validation middleware support
 *
 * Usage:
 * ```typescript
 * export const POST = withApiHandler(async (req, ctx) => {
 *   const data = await doWork(req);
 *   return successResponse(data);
 * }, { serviceName: "checkout-api" });
 * ```
 *
 * @package @repo/shared
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Logger } from "../logger";
import { AppError, ErrorCode } from "../errors";
import { getErrorMetadata } from "../errors/http-codes";
import {
  ApiErrorResponse,
  ApiSuccessResponse,
  errorResponse,
  successResponse,
  formatZodError,
} from "./responses";
import {
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  ServiceUnavailableError,
  NotFoundError,
  RateLimitError,
} from "./errors";
import { isNextRedirectError } from "../utils/next-errors";
import { getTraceId } from "../tracing";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Context passed to API handlers
 */
export interface ApiHandlerContext {
  /** Request trace ID */
  traceId?: string;
  /** Logger instance for the request */
  logger: Logger;
  /** Request metadata */
  request: {
    method: string;
    url: string;
    headers: Headers;
  };
}

/**
 * API handler function type
 */
export type ApiHandler = (
  req: NextRequest,
  ctx: ApiHandlerContext,
) => Promise<NextResponse | ApiSuccessResponse | unknown>;

/**
 * Configuration for the API handler wrapper
 */
export interface ApiHandlerConfig {
  /** Service name for logging */
  serviceName: string;
  /** Include stack traces in error responses (dev only) */
  includeStackTrace?: boolean;
  /** Custom error logger callback */
  onError?: (error: unknown, ctx: ApiHandlerContext) => void;
  /** Hooks to run before handler execution */
  onBefore?: (req: NextRequest, ctx: ApiHandlerContext) => Promise<void>;
  /** Hooks to run after handler execution */
  onAfter?: (response: NextResponse, ctx: ApiHandlerContext) => Promise<void>;
}

// ============================================================================
// ERROR FORMATTING
// ============================================================================

/**
 * Convert any error to standardized API error response
 */
function formatErrorToResponse(
  error: unknown,
  config: ApiHandlerConfig,
  ctx: ApiHandlerContext,
): NextResponse {
  const includeStack =
    config.includeStackTrace ?? process.env.NODE_ENV === "development";
  const traceId = ctx.traceId;

  // Handle known error types
  if (error instanceof ValidationError) {
    const fields = (error as any).fields;
    return NextResponse.json(
      errorResponse(error.code, error.message, {
        statusCode: error.statusCode,
        details: error.details,
        ...(fields && { fields }),
        traceId,
      }),
      { status: error.statusCode },
    );
  }

  if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
    return NextResponse.json(
      errorResponse(error.code, error.message, {
        statusCode: error.statusCode,
        details: error.details,
        traceId,
      }),
      { status: error.statusCode },
    );
  }

  if (error instanceof ConflictError) {
    return NextResponse.json(
      errorResponse(error.code, error.message, {
        statusCode: error.statusCode,
        details: error.details,
        traceId,
      }),
      { status: error.statusCode },
    );
  }

  if (error instanceof NotFoundError) {
    return NextResponse.json(
      errorResponse(error.code, error.message, {
        statusCode: error.statusCode,
        details: error.details,
        traceId,
      }),
      { status: error.statusCode },
    );
  }

  if (error instanceof RateLimitError) {
    const retryAfter = (error.details as any)?.retryAfter;
    return NextResponse.json(
      errorResponse(error.code, error.message, {
        statusCode: error.statusCode,
        details: error.details,
        traceId,
      }),
      {
        status: error.statusCode,
        headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined,
      },
    );
  }

  if (error instanceof ServiceUnavailableError) {
    return NextResponse.json(
      errorResponse(error.code, error.message, {
        statusCode: error.statusCode,
        details: error.details,
        traceId,
      }),
      { status: error.statusCode },
    );
  }

  // Handle AppError instances
  if (error instanceof AppError) {
    const metadata = getErrorMetadata(error.code as ErrorCode);
    return NextResponse.json(
      errorResponse(error.code, error.message, {
        statusCode: error.statusCode,
        details: error.details,
        traceId,
        ...(includeStack && { stack: error.stackTrace }),
      }),
      { status: error.statusCode },
    );
  }

  // Handle Zod errors
  if (error instanceof z.ZodError) {
    return NextResponse.json(formatZodError(error, { traceId }), {
      status: 400,
    });
  }

  // Handle generic errors
  const message =
    error instanceof Error ? error.message : "An unexpected error occurred";
  const defaultCode = "EXECUTION_FAILED" as const;

  return NextResponse.json(
    errorResponse(defaultCode, message, {
      statusCode: 500,
      details: includeStack && error instanceof Error ? error.stack : undefined,
      traceId,
    }),
    { status: 500 },
  );
}

// ============================================================================
// MAIN HANDLER WRAPPER
// ============================================================================

/**
 * Wrap an API route handler with automatic error handling, logging, and tracing
 */
export function withApiHandler(handler: ApiHandler, config: ApiHandlerConfig) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const traceId = getTraceId();
    const logger = new Logger({ serviceName: config.serviceName });

    const ctx: ApiHandlerContext = {
      traceId,
      logger,
      request: {
        method: req.method,
        url: req.url,
        headers: req.headers,
      },
    };

    try {
      // Run pre-execution hooks
      if (config.onBefore) {
        await config.onBefore(req, ctx);
      }

      // Execute handler
      const result = await handler(req, ctx);

      // If handler already returned a NextResponse, pass through
      if (result instanceof NextResponse) {
        // Run post-execution hooks
        if (config.onAfter) {
          await config.onAfter(result, ctx);
        }
        return result;
      }

      // If handler returned a plain object, wrap in success response
      if (result && typeof result === "object") {
        // Check if it's already a success response shape
        if ("success" in result && result.success === true) {
          const response = NextResponse.json(result);
          if (config.onAfter) {
            await config.onAfter(response, ctx);
          }
          return response;
        }

        // Wrap plain data in success response
        const response = NextResponse.json(successResponse(result));
        if (config.onAfter) {
          await config.onAfter(response, ctx);
        }
        return response;
      }

      // Handler returned undefined or primitive - treat as success
      const response = NextResponse.json(successResponse(undefined));
      if (config.onAfter) {
        await config.onAfter(response, ctx);
      }
      return response;
    } catch (error) {
      // Re-throw Next.js redirect/notFound errors to preserve navigation
      if (isNextRedirectError(error)) {
        throw error;
      }

      // Log the error
      logger.error(`[${config.serviceName}] Handler error`, {
        error: error instanceof Error ? error.message : String(error),
        traceId,
        method: req.method,
        url: req.url,
      });

      // Run error hook if provided
      if (config.onError) {
        config.onError(error, ctx);
      }

      // Format and return error response
      return formatErrorToResponse(error, config, ctx);
    }
  };
}
