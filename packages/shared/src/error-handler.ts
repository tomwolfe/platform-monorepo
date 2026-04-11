/**
 * Centralized Error Handler
 *
 * Provides standardized error handling across all API routes and services.
 * Handles error formatting, logging, and Sentry error reporting.
 *
 * Usage:
 * ```typescript
 * // In API route handlers
 * export const POST = withUnifiedApiHandler(async (req: NextRequest) => {
 *   // Your handler logic
 *   throw new ValidationError('Invalid input');
 * });
 * ```
 *
 * @see Phase 1.2: Error Handling & Logging
 * @see SEC-01: Global Error Sanitization
 */

import { AppError, ErrorCode, toAppError } from "./errors";
import {
  formatApiError as _formatApiError,
  validateErrorResponse as _validateErrorResponse,
  type ApiErrorResponse,
  type ApiSuccessResponse,
} from "./utils/api-error";
import { Logger } from "./logger";
import { isNextRedirectError as _isNextRedirectError } from "./utils/next-errors";
import { getErrorMetadata, type ErrorCategory } from "./errors/http-codes";

// ============================================================================
// ERROR RESPONSE FORMAT
// ============================================================================

/**
 * ApiError - A specialized AppError for API route handlers.
 * Provides convenient error formatting for HTTP API responses.
 */
export class ApiError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    statusCode?: number,
    metadata?: Record<string, unknown>,
  ) {
    super(code as unknown as string, message, statusCode, metadata);
    this.name = "ApiError";
  }
}

export interface ApiErrorOptions {
  code: string;
  message: string;
  statusCode?: number;
  details?: Record<string, unknown>;
}

// Re-export ApiErrorResponse from api-error.ts (already imported above)
export { ApiErrorResponse };

// ============================================================================
// ERROR HANDLER CONFIGURATION
// ============================================================================

export interface ErrorHandlerOptions {
  /** Service name for logging */
  serviceName?: string;
  /** Enable detailed stack traces (disable in production) */
  includeStackTrace?: boolean;
  /** Custom error logger */
  logger?: Logger;
  /** Additional context to include in error logs */
  context?: Record<string, unknown>;
}

/**
 * Default error handler options
 */
const _DEFAULT_OPTIONS: ErrorHandlerOptions = {
  serviceName: "api",
  includeStackTrace: process.env.NODE_ENV !== "production",
};

// ============================================================================
// ERROR SANITIZATION (SEC-01)
// Strip stack traces and sensitive details in production
// ============================================================================

/**
 * Sanitize error for external consumption.
 * Removes stack traces and internal details in production.
 *
 * @param error - Error to sanitize
 * @param includeStack - Whether to include stack trace
 * @returns Sanitized error object
 */
export function sanitizeErrorForExternal(
  error: unknown,
  includeStack = process.env.NODE_ENV === "development",
): {
  code: string;
  message: string;
  retryable: boolean;
  category: ErrorCategory;
  details?: Record<string, unknown>;
} {
  const appError = toAppError(error);
  const metadata = getErrorMetadata(appError.code as ErrorCode);

  const sanitized: {
    code: string;
    message: string;
    retryable: boolean;
    category: ErrorCategory;
    details?: Record<string, unknown>;
  } = {
    code: appError.code,
    message: includeStack ? appError.message : appError.message,
    retryable: metadata.retryable,
    category: metadata.category,
  };

  // Include details but strip sensitive fields in production
  if (appError.details) {
    const {
      stack: _stack,
      stackTrace: _stackTrace,
      internal: _internal,
      ...safeDetails
    } = appError.details as Record<string, unknown>;
    sanitized.details = includeStack ? appError.details : safeDetails;
  }

  return sanitized;
}

/**
 * Global unhandled rejection handler.
 * Catches unhandled promise rejections and ensures stack traces are stripped in production.
 * Install this handler once at application startup.
 */
export function installGlobalErrorHandler(logger?: Logger) {
  const errorHandlerLogger =
    logger || new Logger({ serviceName: "global-error-handler" });

  process.on("unhandledRejection", (reason, _promise) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    const isProduction = process.env.NODE_ENV === "production";

    errorHandlerLogger.error({
      message: "Unhandled promise rejection caught by global handler",
      code: "UNHANDLED_REJECTION",
      error: isProduction ? sanitizeErrorForExternal(error, false) : error,
      stack: isProduction ? undefined : error.stack,
    });

    // Don't crash the process - the rejection is already handled by logging
    // This prevents the default behavior of crashing the process
  });

  // Also catch uncaught exceptions
  process.on("uncaughtException", (error) => {
    const isProduction = process.env.NODE_ENV === "production";

    errorHandlerLogger.error({
      message: "Uncaught exception caught by global handler",
      code: "UNCAUGHT_EXCEPTION",
      error: isProduction ? sanitizeErrorForExternal(error, false) : error,
      stack: isProduction ? undefined : error.stack,
    });

    // For uncaught exceptions, we should still exit to be safe
    // but give time for logging to complete
    setTimeout(() => process.exit(1), 1000);
  });
}

// ============================================================================
// ERROR HANDLER
// ============================================================================

/**
 * Centralized error handler for API routes
 *
 * Wraps async route handlers and provides:
 * - Consistent error formatting
 * - Structured error logging
 * - Sentry error reporting (if configured)
 * - Stack trace sanitization for production
 *
 * IMPORTANT: Re-throws Next.js redirect() and notFound() errors to preserve
 * their navigation behavior. These errors contain special digest properties.
 *
 * @param handler - Async route handler function
 * @param options - Error handler configuration
 * @returns Wrapped handler with error handling
 *
 * @example
 * ```typescript
 * export const POST = withUnifiedApiHandler(async (req: NextRequest) => {
 *   const body = await req.json();
 *   if (!body.email) {
 *     throw new ValidationError('Email is required');
 *   }
 *   return { success: true, data: { message: 'Success' } };
 * });
 * ```
 */

// Type for optional observability flush function
type FlushObservabilityFn = () => Promise<void>;

// Module-level reference to flush function (set by apps that use observability)
let _flushObservability: FlushObservabilityFn | null = null;

/**
 * Register a flush function for OpenTelemetry spans.
 * Should be called once during app initialization.
 *
 * @param flushFn - Function that flushes pending spans to the exporter
 *
 * @example
 * ```typescript
 * // In apps/intention-engine/src/lib/observability.ts
 * import { registerObservabilityFlush } from '@repo/shared';
 * registerObservabilityFlush(async () => {
 *   if (sdk) await sdk.forceFlush();
 * });
 * ```
 */
export function registerObservabilityFlush(
  flushFn: FlushObservabilityFn,
): void {
  _flushObservability = flushFn;
}

// ============================================================================
// ERROR FORMATTING UTILITIES
// ============================================================================

/**
 * Format error for API response
 *
 * @param error - Error to format
 * @param code - Error code
 * @param options - Formatting options
 * @returns Formatted error response
 */
export function formatError(
  error: unknown,
  code?: ErrorCode,
  options: {
    includeStack?: boolean;
    traceId?: string;
  } = {},
): ApiErrorResponse {
  const appError = toAppError(error, code);
  const { includeStack = false, traceId } = options;
  const metadata = getErrorMetadata(appError.code as ErrorCode);

  return {
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      retryable: metadata.retryable,
      category: metadata.category,
      ...(appError.details && { details: appError.details }),
      ...(includeStack &&
        appError.stackTrace && { stack: appError.stackTrace }),
    },
    ...(traceId && { traceId }),
  };
}

/**
 * Format success response for API
 *
 * @param data - Response data
 * @param meta - Optional metadata (message, traceId)
 * @returns Formatted success response
 */
export function formatSuccess<T = unknown>(
  data?: T,
  meta?: { message?: string; traceId?: string },
): ApiSuccessResponse<T> {
  const { message, traceId } = meta || {};

  return {
    success: true,
    ...(data !== undefined && { data }),
    ...(message && { message }),
    ...(traceId && { traceId }),
  };
}

// ============================================================================
// ERROR RECOVERY UTILITIES
// ============================================================================

/**
 * Retry function with exponential backoff
 *
 * @param fn - Function to retry
 * @param options - Retry configuration
 * @returns Result of successful execution or throws last error
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => fetchExternalService(),
 *   { maxRetries: 3, initialDelay: 1000 }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    factor?: number;
    shouldRetry?: (error: Error) => boolean;
  } = {},
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    factor = 2,
    shouldRetry,
  } = options;

  let lastError: Error;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      if (shouldRetry && !shouldRetry(lastError)) {
        throw lastError;
      }

      // Don't retry if we've exhausted retries
      if (attempt >= maxRetries) {
        throw lastError;
      }

      // Wait before retrying with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * factor, maxDelay);
    }
  }

  throw lastError!;
}

/**
 * Execute function with timeout
 *
 * @param fn - Function to execute
 * @param timeoutMs - Timeout in milliseconds
 * @param operation - Operation name for error message
 * @returns Result of function execution
 * @throws TimeoutError if operation exceeds timeout
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  operation: string = "operation",
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([fn(), timeoutPromise]);
}

/**
 * Execute multiple promises with partial failure handling
 *
 * @param promises - Array of promises to execute
 * @param options - Configuration
 * @returns Results with success/failure status for each
 *
 * @example
 * ```typescript
 * const results = await settleAll([
 *   fetchUserData(),
 *   fetchUserPreferences(),
 *   fetchUserSettings(),
 * ]);
 *
 * results.forEach(result => {
 *   if (result.status === 'fulfilled') {
 *     console.log('Success:', result.value);
 *   } else {
 *     console.error('Failed:', result.reason);
 *   }
 * });
 * ```
 */
export async function settleAll<T>(
  promises: Array<Promise<T>>,
  options: { stopOnFirstFailure?: boolean } = {},
): Promise<
  Array<
    { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown }
  >
> {
  const { stopOnFirstFailure = false } = options;

  if (stopOnFirstFailure) {
    // Race to first failure
    const results = await Promise.allSettled(promises);
    const firstFailure = results.find((r) => r.status === "rejected");
    if (firstFailure) {
      throw (firstFailure as PromiseRejectedResult).reason;
    }
    return results as Array<{ status: "fulfilled"; value: T }>;
  }

  return Promise.allSettled(promises);
}

// ============================================================================
// SENTRY INTEGRATION (MOVED TO SERVER-ONLY MODULE)
// ============================================================================

/**
 * Sentry integration has been moved to @repo/shared/server
 * to avoid Edge Runtime compatibility issues.
 *
 * For Sentry support, import from the server module:
 * ```typescript
 * import { initSentry, setSentryUser, addSentryBreadcrumb } from '@repo/shared/server';
 * ```
 *
 * The error handler will automatically use Sentry if it has been initialized
 * via the server module.
 */
