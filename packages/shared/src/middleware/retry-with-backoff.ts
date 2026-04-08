/**
 * Retry with Exponential Backoff Middleware
 *
 * Wraps async functions with retry logic using exponential backoff with jitter.
 * Designed for transient failures in serverless environments (network issues, rate limits, etc.).
 *
 * Default retryable errors: ECONNRESET, ETIMEDOUT, ERR_SOCKET_TIMEOUT, and 5xx status codes.
 * Custom retry logic can be provided via the `shouldRetry` option.
 *
 * Usage:
 * ```typescript
 * import { withRetry } from '@repo/shared/middleware/retry-with-backoff';
 *
 * // Basic usage with defaults (3 attempts, 500ms base delay)
 * const result = await withRetry(() => fetchExternalService())();
 *
 * // With custom options
 * const createReservation = withRetry(
 *   reservationService.createReservation.bind(reservationService),
 *   { maxAttempts: 2, baseDelay: 500 }
 * );
 * const result = await createReservation(payload);
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { Logger } from "../logger";

const logger = new Logger({ serviceName: "retry-with-backoff" });

/**
 * Retryable error codes for network-level transient failures
 */
export const DEFAULT_RETRYABLE_CODES = [
  "ECONNRESET",
  "ETIMEDOUT",
  "ERR_SOCKET_TIMEOUT",
];

/**
 * Default maximum number of retry attempts
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Default base delay in milliseconds for exponential backoff
 */
export const DEFAULT_BASE_DELAY = 500;

/**
 * Configuration options for retry behavior
 */
export interface RetryOptions {
  /**
   * Maximum number of attempts (including the initial attempt).
   * @default 3
   */
  maxAttempts?: number;

  /**
   * Base delay in milliseconds for exponential backoff calculation.
   * Actual delay = Math.random() * baseDelay * 2^(attempt - 1)
   * @default 500
   */
  baseDelay?: number;

  /**
   * Error codes that should trigger a retry.
   * Checks the error's `code` property (for Node.js errors)
   * or `cause?.code` property.
   * @default ["ECONNRESET", "ETIMEDOUT", "ERR_SOCKET_TIMEOUT"]
   */
  retryableErrors?: string[];

  /**
   * Custom predicate to determine if an error is retryable.
   * Overrides the default retryableErrors check when provided.
   *
   * @param error - The caught error
   * @returns true if the error should trigger a retry
   */
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Normalized retry configuration with defaults applied
 */
interface NormalizedRetryConfig {
  maxAttempts: number;
  baseDelay: number;
  retryableErrors: string[];
  shouldRetry: (error: unknown) => boolean;
}

/**
 * Interface for errors with HTTP-like status codes
 */
interface HttpError extends Error {
  status?: number;
  statusCode?: number;
  response?: { status?: number };
}

/**
 * Check if an error is a transient network error based on error codes
 */
function isRetryableNetworkError(
  error: unknown,
  retryableErrors: string[],
): boolean {
  if (error instanceof Error) {
    // Check error code property
    if ("code" in error && typeof error.code === "string") {
      return retryableErrors.includes(error.code);
    }
    // Check cause.code for wrapped errors
    if (
      "cause" in error &&
      error.cause instanceof Error &&
      "code" in error.cause &&
      typeof error.cause.code === "string"
    ) {
      return retryableErrors.includes(error.cause.code);
    }
  }
  return false;
}

/**
 * Check if an error has a 5xx HTTP status code
 */
function is5xxError(error: unknown): boolean {
  if (error instanceof Error) {
    const httpError = error as HttpError;
    // Check for HTTP response errors with status codes
    if (typeof httpError.status === "number") {
      return httpError.status >= 500 && httpError.status < 600;
    }
    // Check for response object with status (common in fetch/axios patterns)
    if (httpError.response && typeof httpError.response.status === "number") {
      return (
        httpError.response.status >= 500 && httpError.response.status < 600
      );
    }
    // Check for statusCode property directly on the error
    if (typeof httpError.statusCode === "number") {
      return httpError.statusCode >= 500 && httpError.statusCode < 600;
    }
  }
  return false;
}

/**
 * Normalize retry options with defaults
 */
function normalizeRetryOptions(options?: RetryOptions): NormalizedRetryConfig {
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelay = options?.baseDelay ?? DEFAULT_BASE_DELAY;
  const retryableErrors = options?.retryableErrors ?? DEFAULT_RETRYABLE_CODES;

  let shouldRetry: (error: unknown) => boolean;

  if (options?.shouldRetry) {
    // Use custom predicate if provided
    shouldRetry = options.shouldRetry;
  } else {
    // Default: retry on known network errors or 5xx status codes
    shouldRetry = (error: unknown) => {
      return (
        isRetryableNetworkError(error, retryableErrors) || is5xxError(error)
      );
    };
  }

  return {
    maxAttempts,
    baseDelay,
    retryableErrors,
    shouldRetry,
  };
}

/**
 * Calculate delay with exponential backoff and jitter.
 *
 * Formula: delay = Math.random() * baseDelay * 2^(attempt - 1)
 *
 * The jitter prevents the thundering herd problem when multiple
 * requests fail and retry simultaneously.
 *
 * @param attempt - Current attempt number (1-based)
 * @param baseDelay - Base delay in milliseconds
 * @returns Delay in milliseconds
 */
function calculateBackoffDelay(attempt: number, baseDelay: number): number {
  return Math.random() * baseDelay * Math.pow(2, attempt - 1);
}

/**
 * Wrap an async function with retry logic using exponential backoff with jitter.
 *
 * The returned function has the same signature as the original handler.
 * Retries are only attempted for transient errors (network errors, 5xx responses)
 * unless a custom `shouldRetry` predicate is provided.
 *
 * @param handler - The async function to wrap
 * @param options - Retry configuration options
 * @returns A new function with the same signature that includes retry logic
 *
 * @example
 * ```typescript
 * // Wrap a service method
 * const createReservationWithRetry = withRetry(
 *   reservationService.createReservation.bind(reservationService),
 *   { maxAttempts: 2, baseDelay: 500 }
 * );
 *
 * // Use it like the original function
 * const result = await createReservationWithRetry(payload);
 *
 * // With custom retry logic
 * const fetchWithRetry = withRetry(
 *   () => fetchExternalAPI(),
 *   {
 *     maxAttempts: 5,
 *     baseDelay: 1000,
 *     shouldRetry: (error) => {
 *       // Retry on rate limits (429) and server errors (5xx)
 *       return error?.status === 429 || error?.status >= 500;
 *     }
 *   }
 * );
 * ```
 */
export function withRetry<T extends (...args: any[]) => Promise<any>>(
  handler: T,
  options?: RetryOptions,
): T {
  const config = normalizeRetryOptions(options);

  return (async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
      try {
        return await handler(...args);
      } catch (error) {
        lastError = error;

        // Check if we should retry this error
        if (!config.shouldRetry(error)) {
          throw error;
        }

        // Check if we have remaining attempts
        if (attempt >= config.maxAttempts) {
          // All retries exhausted - re-throw the last error
          break;
        }

        // Calculate delay with exponential backoff and jitter
        const delay = calculateBackoffDelay(attempt, config.baseDelay);

        // Log retry attempt with structured data
        const errorCode =
          error instanceof Error && "code" in error
            ? (error as HttpError).code
            : undefined;

        logger.warn("Retrying operation", {
          attempt,
          maxAttempts: config.maxAttempts,
          delay: Math.round(delay),
          error: error instanceof Error ? error.message : String(error),
          errorCode,
          timestamp: new Date().toISOString(),
        });

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    // All retries exhausted - throw the last error
    throw lastError;
  }) as T;
}
