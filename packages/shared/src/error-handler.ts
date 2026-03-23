/**
 * Centralized Error Handler
 *
 * Provides standardized error handling across all API routes and services.
 * Handles error formatting, logging, and Sentry reporting.
 *
 * Usage:
 * ```typescript
 * // In API route handlers
 * export const POST = withApiErrorHandler(async (req: NextRequest) => {
 *   // Your handler logic
 *   throw new ValidationError('Invalid input');
 * });
 * ```
 *
 * @see Phase 1.2: Error Handling & Logging
 */

import {
  AppError,
  ErrorCode,
  toAppError,
  getErrorStatusCode,
  formatApiError,
} from '@repo/shared';
import { Logger } from './logger';

// ============================================================================
// ERROR RESPONSE FORMAT
// ============================================================================

/**
 * Standardized API error response
 */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    stack?: string;
  };
  timestamp: string;
  traceId?: string;
}

/**
 * Standardized API success response
 */
export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data?: T;
  message?: string;
  timestamp: string;
  traceId?: string;
}

/**
 * Union type for API responses
 */
export type ApiResponse<T = unknown> =
  | ApiSuccessResponse<T>
  | ApiErrorResponse;

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
  /** Enable Sentry error reporting */
  enableSentry?: boolean;
  /** Additional context to include in error logs */
  context?: Record<string, unknown>;
}

/**
 * Default error handler options
 */
const DEFAULT_OPTIONS: ErrorHandlerOptions = {
  serviceName: 'api',
  includeStackTrace: process.env.NODE_ENV !== 'production',
  enableSentry: process.env.SENTRY_DSN ? true : false,
};

// ============================================================================
// ERROR HANDLER
// ============================================================================

/**
 * Centralized error handler for API routes
 *
 * Wraps async route handlers and provides:
 * - Consistent error response formatting
 * - Structured error logging
 * - Sentry error reporting (if configured)
 * - Stack trace sanitization for production
 *
 * @param handler - Async route handler function
 * @param options - Error handler configuration
 * @returns Wrapped handler with error handling
 *
 * @example
 * ```typescript
 * export const POST = withApiErrorHandler(async (req: NextRequest) => {
 *   const body = await req.json();
 *   if (!body.email) {
 *     throw new ValidationError('Email is required');
 *   }
 *   return { success: true, data: { message: 'Success' } };
 * });
 * ```
 */
export function withApiErrorHandler<T extends (...args: any[]) => Promise<any>>(
  handler: T,
  options: ErrorHandlerOptions = DEFAULT_OPTIONS
) {
  const {
    serviceName = DEFAULT_OPTIONS.serviceName,
    includeStackTrace = DEFAULT_OPTIONS.includeStackTrace,
    enableSentry = DEFAULT_OPTIONS.enableSentry,
    context = {},
  } = options;

  const logger = options.logger || new Logger({ serviceName });

  return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    try {
      return await handler(...args);
    } catch (error) {
      const appError = toAppError(error);

      // Extract trace ID from error context or args
      const traceId =
        appError.details?.traceId as string ||
        (args[0] as any)?.headers?.get?.('x-trace-id') ||
        undefined;

      // Log error with structured context
      logger.error({
        message: appError.message,
        code: appError.code,
        statusCode: appError.statusCode,
        details: appError.details,
        traceId,
        stack: includeStackTrace ? appError.stackTrace : undefined,
        ...context,
      });

      // Report to Sentry if enabled
      if (enableSentry && typeof Sentry !== 'undefined') {
        try {
          Sentry.captureException(appError, {
            tags: {
              error_code: appError.code,
              service: serviceName,
            },
            extra: {
              details: appError.details,
              traceId,
            },
          });
        } catch (sentryError) {
          // Don't let Sentry errors break error handling
          console.error('Sentry reporting failed:', sentryError);
        }
      }

      // Return formatted error response
      return formatApiError(appError, appError.code as ErrorCode, {
        includeStack: includeStackTrace,
        traceId,
      }) as ReturnType<T>;
    }
  };
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
  } = {}
): ApiErrorResponse {
  const appError = toAppError(error, code);
  const { includeStack = false, traceId } = options;

  return {
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details && { details: appError.details }),
      ...(includeStack && appError.stackTrace && { stack: appError.stackTrace }),
    },
    timestamp: new Date().toISOString(),
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
  meta?: { message?: string; traceId?: string }
): ApiSuccessResponse<T> {
  const { message, traceId } = meta || {};

  return {
    success: true,
    ...(data !== undefined && { data }),
    ...(message && { message }),
    timestamp: new Date().toISOString(),
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
  } = {}
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
      await new Promise(resolve => setTimeout(resolve, delay));
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
  operation: string = 'Operation'
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
  options: { stopOnFirstFailure?: boolean } = {}
): Promise<
  Array<
    | { status: 'fulfilled'; value: T }
    | { status: 'rejected'; reason: unknown }
  >
> {
  const { stopOnFirstFailure = false } = options;

  if (stopOnFirstFailure) {
    // Race to first failure
    const results = await Promise.allSettled(promises);
    const firstFailure = results.find(r => r.status === 'rejected');
    if (firstFailure) {
      throw (firstFailure as PromiseRejectedResult).reason;
    }
    return results as Array<{ status: 'fulfilled'; value: T }>;
  }

  return Promise.allSettled(promises);
}

// ============================================================================
// SENTRY INTEGRATION (OPTIONAL)
// ============================================================================

/**
 * Sentry namespace for optional import
 * This is dynamically imported only if Sentry is configured
 */
let Sentry: typeof import('@sentry/node') | undefined;

/**
 * Initialize Sentry error tracking
 * Call this once at application startup
 *
 * @param dsn - Sentry DSN
 * @param options - Sentry configuration
 */
export async function initSentry(
  dsn: string,
  options: {
    environment?: string;
    release?: string;
    tracesSampleRate?: number;
  } = {}
) {
  try {
    Sentry = await import('@sentry/node');

    Sentry.init({
      dsn,
      environment: options.environment || process.env.NODE_ENV,
      release: options.release,
      tracesSampleRate: options.tracesSampleRate || 0.1,
      integrations: [
        new Sentry.Integrations.Http({ tracing: true }),
        new Sentry.Integrations.Express({ app: undefined }),
      ],
    });

    console.log('[ErrorHandler] Sentry initialized');
  } catch (error) {
    console.warn('[ErrorHandler] Failed to initialize Sentry:', error);
  }
}

/**
 * Configure Sentry user context for better error tracking
 *
 * @param user - User information
 */
export function setSentryUser(user: {
  id?: string;
  email?: string;
  username?: string;
}) {
  if (Sentry) {
    Sentry.setUser(user);
  }
}

/**
 * Add Sentry breadcrumb for debugging
 *
 * @param message - Breadcrumb message
 * @param data - Additional data
 */
export function addSentryBreadcrumb(message: string, data?: Record<string, unknown>) {
  if (Sentry) {
    Sentry.addBreadcrumb({
      message,
      data,
      level: 'info',
    });
  }
}
