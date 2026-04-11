/**
 * HTTP Error Class & Global Error Handler
 *
 * Provides a lightweight `HttpError` class for route-level error throwing
 * and utility functions for formatting errors into standardized responses.
 *
 * This complements the heavier `AppError` class in `errors.ts` by providing
 * a simpler alternative for API routes that don't need full error metadata.
 *
 * Usage:
 * ```typescript
 * // In an API route:
 * throw new HttpError(400, "Invalid input: email is required");
 * throw new HttpError(404, "User not found", { code: "USER_NOT_FOUND", details: { userId } });
 *
 * // With withUnifiedApiHandler (automatic error handling):
 * export const GET = withUnifiedApiHandler(async (req) => { ... }, { serviceName: "my-api" });
 * ```
 *
 * @package @repo/shared
 */

// ============================================================================
// HTTP ERROR CLASS
// ============================================================================

/**
 * Lightweight HTTP error with status code and optional details.
 *
 * Simpler than `AppError` — ideal for API routes that just need
 * to signal an HTTP status and message without full error metadata.
 */
export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    message: string,
    options?: { code?: string; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = options?.code;
    this.details = options?.details;
  }

  /**
   * Create a 400 Bad Request error
   */
  static badRequest(
    message: string,
    details?: Record<string, unknown>,
  ): HttpError {
    return new HttpError(400, message, { code: "BAD_REQUEST", details });
  }

  /**
   * Create a 401 Unauthorized error
   */
  static unauthorized(message: string = "Unauthorized"): HttpError {
    return new HttpError(401, message, { code: "UNAUTHORIZED" });
  }

  /**
   * Create a 403 Forbidden error
   */
  static forbidden(message: string = "Forbidden"): HttpError {
    return new HttpError(403, message, { code: "FORBIDDEN" });
  }

  /**
   * Create a 404 Not Found error
   */
  static notFound(
    message: string,
    details?: Record<string, unknown>,
  ): HttpError {
    return new HttpError(404, message, { code: "NOT_FOUND", details });
  }

  /**
   * Create a 409 Conflict error
   */
  static conflict(
    message: string,
    details?: Record<string, unknown>,
  ): HttpError {
    return new HttpError(409, message, { code: "CONFLICT", details });
  }

  /**
   * Create a 429 Too Many Requests error
   */
  static tooManyRequests(retryAfter?: number): HttpError {
    return new HttpError(429, "Too many requests", {
      code: "RATE_LIMITED",
      details: retryAfter ? { retryAfterSeconds: retryAfter } : undefined,
    });
  }

  /**
   * Create a 500 Internal Server Error
   */
  static internal(message: string = "Internal server error"): HttpError {
    return new HttpError(500, message, { code: "INTERNAL_ERROR" });
  }
}

// ============================================================================
// ERROR RESPONSE FORMATTING
// ============================================================================

/**
 * Standardized error response shape (framework-agnostic).
 */
export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    stack?: string;
  };
}

/**
 * Format an error into a standardized response object with status code.
 *
 * Handles HttpError, AppError, and generic Error types.
 * Returns a plain object + status code so it works with any framework.
 */
export function formatErrorResponse(
  error: unknown,
  options?: { includeStackTrace?: boolean },
): { body: ErrorResponse; status: number } {
  const { includeStackTrace = false } = options || {};

  if (error instanceof HttpError) {
    return {
      status: error.statusCode,
      body: {
        success: false,
        error: {
          code: error.code || "HTTP_ERROR",
          message: error.message,
          ...(error.details && { details: error.details }),
          ...(includeStackTrace && error.stack && { stack: error.stack }),
        },
      },
    };
  }

  // Check for AppError (from errors.ts)
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    "code" in error &&
    "message" in error
  ) {
    const appError = error as Record<string, unknown>;
    const statusCode = (appError.statusCode as number) || 500;
    const details = appError.details as Record<string, unknown> | undefined;
    return {
      status: statusCode,
      body: {
        success: false,
        error: {
          code: (appError.code as string) || "EXECUTION_FAILED",
          message: (appError.message as string) || "An error occurred",
          ...(details && { details }),
        },
      },
    };
  }

  // Generic error fallback
  const message =
    error instanceof Error ? error.message : "An unexpected error occurred";
  const stack =
    includeStackTrace && error instanceof Error ? error.stack : undefined;
  return {
    status: 500,
    body: {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message,
        ...(stack && { stack }),
      },
    },
  };
}
