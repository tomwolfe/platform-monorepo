/**
 * Async Boundary Errors
 *
 * Structured error types for async boundaries (QStash, Ably, webhooks)
 * that enable reliable Dead Letter Queue (DLQ) routing and structured retries.
 *
 * Generic `Error` throws across async boundaries prevent DLQ systems from
 * determining whether an error is retryable. These structured errors provide:
 * - Machine-readable error codes
 * - Explicit retryable flag
 * - Context for debugging and DLQ routing
 *
 * Usage:
 * ```typescript
 * // In QStash webhook handler
 * try {
 *   await processWebhook(event);
 * } catch (error) {
 *   if (error instanceof AsyncBoundaryError && error.retryable) {
 *     // QStash will automatically retry
 *     throw error;
 *   }
 *   // Non-retryable errors go to DLQ for manual inspection
 *   await sendToDLQ(error);
 * }
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { AppError, ErrorCode } from "../errors";

/**
 * Async boundary error codes for DLQ routing
 */
export const AsyncBoundaryErrorCode = {
  // Retryable errors
  QSTASH_PUBLISH_FAILED: "QSTASH_PUBLISH_FAILED",
  ABLY_PUBLISH_FAILED: "ABLY_PUBLISH_FAILED",
  WEBHOOK_DELIVERY_FAILED: "WEBHOOK_DELIVERY_FAILED",
  DATABASE_TRANSIENT_ERROR: "DATABASE_TRANSIENT_ERROR",
  EXTERNAL_SERVICE_TIMEOUT: "EXTERNAL_SERVICE_TIMEOUT",
  RATE_LIMITED_RETRYABLE: "RATE_LIMITED_RETRYABLE",

  // Non-retryable errors
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  DUPLICATE_EVENT: "DUPLICATE_EVENT",
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",
  PERMANENT_FAILURE: "PERMANENT_FAILURE",
} as const;

export type AsyncBoundaryErrorCode =
  (typeof AsyncBoundaryErrorCode)[keyof typeof AsyncBoundaryErrorCode];

/**
 * Context for async boundary errors
 * Provides structured metadata for DLQ routing and debugging
 */
export interface AsyncBoundaryErrorContext {
  /** Source service (e.g., 'qstash', 'ably', 'webhook-dispatcher') */
  source: string;
  /** Operation that failed */
  operation: string;
  /** Additional context (e.g., executionId, eventId, webhookUrl) */
  context?: Record<string, unknown>;
  /** Original error that triggered this boundary error */
  originalError?: Error;
  /** Number of retry attempts so far */
  retryCount?: number;
  /** Maximum retry attempts configured */
  maxRetries?: number;
}

/**
 * Base error for async boundary failures
 *
 * Extends AppError with retryable flag and structured context
 * for DLQ routing and retry logic.
 *
 * @example
 * ```typescript
 * throw new AsyncBoundaryError(
 *   AsyncBoundaryErrorCode.QSTASH_PUBLISH_FAILED,
 *   'Failed to publish to QStash: connection timeout',
 *   true, // retryable
 *   { source: 'qstash', operation: 'publish', context: { executionId: '...' } }
 * );
 * ```
 */
export class AsyncBoundaryError extends AppError {
  /**
   * Whether this error should be retried
   * - true: QStash/Ably will automatically retry
   * - false: Error goes to DLQ for manual inspection
   */
  public readonly retryable: boolean;

  /**
   * Machine-readable error code for DLQ routing
   */
  public readonly asyncCode: AsyncBoundaryErrorCode;

  /**
   * Structured context for debugging
   */
  public readonly asyncContext: AsyncBoundaryErrorContext;

  constructor(
    asyncCode: AsyncBoundaryErrorCode,
    message: string,
    retryable: boolean = false,
    context?: Partial<AsyncBoundaryErrorContext>,
  ) {
    const statusCode = retryable ? 503 : 400;
    const errorCode = retryable
      ? ErrorCode.SERVICE_UNAVAILABLE
      : ErrorCode.EXECUTION_FAILED;

    super(errorCode, message, statusCode);
    this.name = "AsyncBoundaryError";
    this.asyncCode = asyncCode;
    this.retryable = retryable;
    this.asyncContext = {
      source: context?.source || "unknown",
      operation: context?.operation || "unknown",
      context: context?.context,
      originalError: context?.originalError,
      retryCount: context?.retryCount,
      maxRetries: context?.maxRetries,
    };

    // Preserve stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AsyncBoundaryError);
    }
  }

  /**
   * Convert error to JSON for DLQ storage
   */
  toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      asyncCode: this.asyncCode,
      retryable: this.retryable,
      context: this.asyncContext,
    };
  }

  /**
   * Convert error to log entry with full context
   */
  toLogEntry(): Record<string, unknown> {
    return {
      ...super.toLogEntry(),
      asyncCode: this.asyncCode,
      retryable: this.retryable,
      source: this.asyncContext.source,
      operation: this.asyncContext.operation,
      context: this.asyncContext.context,
      retryCount: this.asyncContext.retryCount,
      maxRetries: this.asyncContext.maxRetries,
    };
  }
}

/**
 * Factory: Create retryable async boundary error
 *
 * @example
 * ```typescript
 * throw retryableError(
 *   AsyncBoundaryErrorCode.QSTASH_PUBLISH_FAILED,
 *   'QStash connection timeout',
 *   { source: 'qstash', operation: 'publish', retryCount: 2 }
 * );
 * ```
 */
export function retryableError(
  code: AsyncBoundaryErrorCode,
  message: string,
  context?: Partial<AsyncBoundaryErrorContext>,
): AsyncBoundaryError {
  return new AsyncBoundaryError(code, message, true, context);
}

/**
 * Factory: Create non-retryable async boundary error
 *
 * @example
 * ```typescript
 * throw permanentError(
 *   AsyncBoundaryErrorCode.INVALID_PAYLOAD,
 *   'Webhook payload missing required executionId',
 *   { source: 'webhook-dispatcher', operation: 'handle' }
 * );
 * ```
 */
export function permanentError(
  code: AsyncBoundaryErrorCode,
  message: string,
  context?: Partial<AsyncBoundaryErrorContext>,
): AsyncBoundaryError {
  return new AsyncBoundaryError(code, message, false, context);
}

/**
 * Check if an error is an async boundary error
 */
export function isAsyncBoundaryError(
  error: unknown,
): error is AsyncBoundaryError {
  return error instanceof AsyncBoundaryError;
}

/**
 * Check if an error should be retried
 *
 * Returns true for:
 * - AsyncBoundaryError with retryable=true
 * - Network errors (ECONNREFUSED, ETIMEDOUT, etc.)
 * - Timeout errors
 *
 * Returns false for:
 * - AsyncBoundaryError with retryable=false
 * - Validation errors
 * - Configuration errors
 */
export function shouldRetry(error: unknown): boolean {
  if (error instanceof AsyncBoundaryError) {
    return error.retryable;
  }

  // Check for common retryable network errors
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const code = (error as NodeJS.ErrnoException).code?.toLowerCase();

    return (
      message.includes("timeout") ||
      message.includes("econnrefused") ||
      message.includes("etimedout") ||
      message.includes("enotfound") ||
      code === "econnrefused" ||
      code === "etimedout" ||
      code === "enotfound"
    );
  }

  // Default: don't retry unknown errors
  return false;
}
