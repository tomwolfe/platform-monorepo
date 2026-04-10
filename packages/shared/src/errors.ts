/**
 * Standardized Error Classes
 *
 * Provides a unified error handling system across all services.
 * All errors extend AppError for consistent error codes, status codes, and metadata.
 *
 * @package @repo/shared
 * @since 1.0.0
 */

// ============================================================================
// ERROR CODES
// ============================================================================

/**
 * Standardized error codes for programmatic error handling
 */
export const ErrorCode = {
  // Validation Errors (400)
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_INPUT: "INVALID_INPUT",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  INVALID_FORMAT: "INVALID_FORMAT",

  // Authentication Errors (401, 403)
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_TOKEN: "INVALID_TOKEN",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  FORBIDDEN: "FORBIDDEN",
  INSUFFICIENT_PERMISSIONS: "INSUFFICIENT_PERMISSIONS",

  // Resource Errors (404, 409)
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  RESOURCE_UNAVAILABLE: "RESOURCE_UNAVAILABLE",

  // Rate Limiting (429)
  RATE_LIMITED: "RATE_LIMITED",

  // Execution Errors (500)
  EXECUTION_FAILED: "EXECUTION_FAILED",
  TIMEOUT: "TIMEOUT",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  DATABASE_ERROR: "DATABASE_ERROR",
  EXTERNAL_SERVICE_ERROR: "EXTERNAL_SERVICE_ERROR",

  // Saga/Workflow Errors
  SAGA_COMPENSATION_FAILED: "SAGA_COMPENSATION_FAILED",
  STATE_TRANSITION_INVALID: "STATE_TRANSITION_INVALID",

  // Business Logic Errors
  BUSINESS_RULE_VIOLATION: "BUSINESS_RULE_VIOLATION",
  CLARIFICATION_REQUIRED: "CLARIFICATION_REQUIRED",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ============================================================================
// ERROR CODE METADATA
// ============================================================================

/**
 * HTTP status code mapping for each error code
 */
export const ERROR_STATUS_MAP: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INVALID_INPUT: 400,
  MISSING_REQUIRED_FIELD: 400,
  INVALID_FORMAT: 400,
  UNAUTHORIZED: 401,
  INVALID_TOKEN: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  INSUFFICIENT_PERMISSIONS: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ALREADY_EXISTS: 409,
  RESOURCE_UNAVAILABLE: 409,
  RATE_LIMITED: 429,
  EXECUTION_FAILED: 500,
  TIMEOUT: 504,
  SERVICE_UNAVAILABLE: 503,
  DATABASE_ERROR: 500,
  EXTERNAL_SERVICE_ERROR: 500,
  SAGA_COMPENSATION_FAILED: 500,
  STATE_TRANSITION_INVALID: 500,
  BUSINESS_RULE_VIOLATION: 400,
  CLARIFICATION_REQUIRED: 400,
};

// ============================================================================
// BASE ERROR CLASS
// ============================================================================

/**
 * Base application error class
 *
 * All custom errors extend this class for consistent error handling.
 * Provides error codes, HTTP status codes, and optional metadata.
 *
 * @example
 * ```typescript
 * throw new AppError(
 *   ErrorCode.VALIDATION_ERROR,
 *   'Invalid email format',
 *   400,
 *   { field: 'email', value: 'invalid' }
 * );
 * ```
 */
export class AppError extends Error {
  /**
   * Machine-readable error code
   */
  public readonly code: ErrorCode;

  /**
   * HTTP status code
   */
  public readonly statusCode: number;

  /**
   * Optional metadata for additional context
   */
  public readonly details?: Record<string, unknown>;

  /**
   * Timestamp when the error occurred
   */
  public readonly timestamp: string;

  /**
   * Optional stack trace (for server-side debugging)
   */
  public readonly stackTrace?: string;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number = 500,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();

    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
    this.stackTrace = this.stack;
  }

  /**
   * Convert error to JSON for API responses
   */
  toJSON(): Record<string, unknown> {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
      },
      timestamp: this.timestamp,
    };
  }

  /**
   * Convert error to log entry
   */
  toLogEntry(): Record<string, unknown> {
    return {
      type: "APP_ERROR",
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
      timestamp: this.timestamp,
      stack: this.stackTrace,
    };
  }
}

// ============================================================================
// VALIDATION ERRORS
// ============================================================================

/**
 * Validation error for invalid input
 */
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.VALIDATION_ERROR, message, 400, details);
    this.name = "ValidationError";
  }
}

/**
 * Error for missing required fields
 */
export class MissingFieldError extends AppError {
  constructor(fieldName: string, details?: Record<string, unknown>) {
    super(
      ErrorCode.MISSING_REQUIRED_FIELD,
      `Missing required field: ${fieldName}`,
      400,
      { field: fieldName, ...details },
    );
    this.name = "MissingFieldError";
  }
}

/**
 * Error for invalid input format
 */
export class InvalidFormatError extends AppError {
  constructor(
    fieldName: string,
    expectedFormat: string,
    actualValue?: unknown,
  ) {
    super(
      ErrorCode.INVALID_FORMAT,
      `Invalid format for field: ${fieldName}. Expected: ${expectedFormat}`,
      400,
      { field: fieldName, expectedFormat, actualValue },
    );
    this.name = "InvalidFormatError";
  }
}

// ============================================================================
// AUTHENTICATION ERRORS
// ============================================================================

/**
 * Unauthorized error (401)
 */
export class UnauthorizedError extends AppError {
  constructor(
    message: string = "Unauthorized",
    details?: Record<string, unknown>,
  ) {
    super(ErrorCode.UNAUTHORIZED, message, 401, details);
    this.name = "UnauthorizedError";
  }
}

/**
 * Invalid token error
 */
export class InvalidTokenError extends AppError {
  constructor(
    message: string = "Invalid or expired token",
    details?: Record<string, unknown>,
  ) {
    super(ErrorCode.INVALID_TOKEN, message, 401, details);
    this.name = "InvalidTokenError";
  }
}

/**
 * Token expired error
 */
export class TokenExpiredError extends AppError {
  constructor(expiredAt?: Date) {
    super(
      ErrorCode.TOKEN_EXPIRED,
      "Token has expired",
      401,
      expiredAt ? { expiredAt: expiredAt.toISOString() } : undefined,
    );
    this.name = "TokenExpiredError";
  }
}

/**
 * Forbidden error (403)
 */
export class ForbiddenError extends AppError {
  constructor(
    message: string = "Forbidden",
    details?: Record<string, unknown>,
  ) {
    super(ErrorCode.FORBIDDEN, message, 403, details);
    this.name = "ForbiddenError";
  }
}

/**
 * Insufficient permissions error
 */
export class InsufficientPermissionsError extends AppError {
  constructor(requiredPermission?: string, details?: Record<string, unknown>) {
    super(
      ErrorCode.INSUFFICIENT_PERMISSIONS,
      requiredPermission
        ? `Insufficient permissions. Required: ${requiredPermission}`
        : "Insufficient permissions",
      403,
      { requiredPermission, ...details },
    );
    this.name = "InsufficientPermissionsError";
  }
}

// ============================================================================
// RESOURCE ERRORS
// ============================================================================

/**
 * Resource not found error (404)
 */
export class NotFoundError extends AppError {
  constructor(
    resourceType: string,
    identifier?: string,
    details?: Record<string, unknown>,
  ) {
    super(
      ErrorCode.NOT_FOUND,
      identifier
        ? `${resourceType} not found: ${identifier}`
        : `${resourceType} not found`,
      404,
      { resourceType, identifier, ...details },
    );
    this.name = "NotFoundError";
  }
}

/**
 * Conflict error (409)
 */
export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.CONFLICT, message, 409, details);
    this.name = "ConflictError";
  }
}

/**
 * Resource already exists error
 */
export class AlreadyExistsError extends AppError {
  constructor(
    resourceType: string,
    identifier: string,
    details?: Record<string, unknown>,
  ) {
    super(
      ErrorCode.ALREADY_EXISTS,
      `${resourceType} already exists: ${identifier}`,
      409,
      { resourceType, identifier, ...details },
    );
    this.name = "AlreadyExistsError";
  }
}

/**
 * Resource unavailable error
 */
export class ResourceUnavailableError extends AppError {
  constructor(
    resourceType: string,
    reason?: string,
    details?: Record<string, unknown>,
  ) {
    super(
      ErrorCode.RESOURCE_UNAVAILABLE,
      reason
        ? `${resourceType} unavailable: ${reason}`
        : `${resourceType} unavailable`,
      409,
      { resourceType, reason, ...details },
    );
    this.name = "ResourceUnavailableError";
  }
}

// ============================================================================
// RATE LIMITING ERRORS
// ============================================================================

/**
 * Rate limit exceeded error (429)
 */
export class RateLimitError extends AppError {
  constructor(retryAfter?: number, details?: Record<string, unknown>) {
    super(
      ErrorCode.RATE_LIMITED,
      "Too many requests. Please try again later.",
      429,
      { retryAfter, ...details },
    );
    this.name = "RateLimitError";
  }
}

// ============================================================================
// EXECUTION ERRORS
// ============================================================================

/**
 * General execution failure error
 */
export class ExecutionError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.EXECUTION_FAILED, message, 500, details);
    this.name = "ExecutionError";
  }
}

/**
 * Timeout error
 */
export class TimeoutError extends AppError {
  constructor(
    operation: string,
    timeoutMs?: number,
    details?: Record<string, unknown>,
  ) {
    super(
      ErrorCode.TIMEOUT,
      `Operation timed out: ${operation}${timeoutMs ? ` after ${timeoutMs}ms` : ""}`,
      504,
      { operation, timeoutMs, ...details },
    );
    this.name = "TimeoutError";
  }
}

/**
 * Service unavailable error
 */
export class ServiceUnavailableError extends AppError {
  constructor(
    serviceName?: string,
    reason?: string,
    details?: Record<string, unknown>,
  ) {
    super(
      ErrorCode.SERVICE_UNAVAILABLE,
      reason
        ? `Service unavailable: ${serviceName || "Unknown"} - ${reason}`
        : `Service unavailable: ${serviceName || "Unknown"}`,
      503,
      { serviceName, reason, ...details },
    );
    this.name = "ServiceUnavailableError";
  }
}

/**
 * Database error
 */
export class DatabaseError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(ErrorCode.DATABASE_ERROR, message, 500, details);
    this.name = "DatabaseError";
  }
}

/**
 * External service error
 */
export class ExternalServiceError extends AppError {
  constructor(
    serviceName: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(
      ErrorCode.EXTERNAL_SERVICE_ERROR,
      `External service error (${serviceName}): ${message}`,
      500,
      { serviceName, ...details },
    );
    this.name = "ExternalServiceError";
  }
}

// ============================================================================
// SAGA/WORKFLOW ERRORS
// ============================================================================

/**
 * Saga compensation failed error
 */
export class SagaCompensationFailedError extends AppError {
  constructor(
    sagaId: string,
    failedStep: string,
    details?: Record<string, unknown>,
  ) {
    super(
      ErrorCode.SAGA_COMPENSATION_FAILED,
      `Saga compensation failed: ${sagaId} at step ${failedStep}`,
      500,
      { sagaId, failedStep, ...details },
    );
    this.name = "SagaCompensationFailedError";
  }
}

/**
 * State transition invalid error
 */
export class StateTransitionInvalidError extends AppError {
  constructor(
    currentState: string,
    targetState: string,
    details?: Record<string, unknown>,
  ) {
    super(
      ErrorCode.STATE_TRANSITION_INVALID,
      `Invalid state transition: ${currentState} -> ${targetState}`,
      500,
      { currentState, targetState, ...details },
    );
    this.name = "StateTransitionInvalidError";
  }
}

// ============================================================================
// BUSINESS LOGIC ERRORS
// ============================================================================

/**
 * Business rule violation error
 */
export class BusinessRuleViolationError extends AppError {
  constructor(
    ruleName: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(
      ErrorCode.BUSINESS_RULE_VIOLATION,
      `Business rule violation (${ruleName}): ${message}`,
      400,
      { ruleName, ...details },
    );
    this.name = "BusinessRuleViolationError";
  }
}

/**
 * Clarification required error
 */
export class ClarificationRequiredError extends AppError {
  constructor(
    message: string,
    clarificationsNeeded: string[],
    details?: Record<string, unknown>,
  ) {
    super(ErrorCode.CLARIFICATION_REQUIRED, message, 400, {
      clarificationsNeeded,
      ...details,
    });
    this.name = "ClarificationRequiredError";
  }
}

// ============================================================================
// ERROR HANDLING UTILITIES
// ============================================================================

/**
 * Check if an error is an AppError
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Get the appropriate HTTP status code for an error
 */
export function getErrorStatusCode(error: unknown): number {
  if (error instanceof AppError) {
    return error.statusCode;
  }
  if (error instanceof Error) {
    return 500;
  }
  return 500;
}

/**
 * Convert any error to AppError
 */
export function toAppError(
  error: unknown,
  defaultCode: ErrorCode = ErrorCode.INTERNAL_ERROR as any,
  defaultMessage: string = "An unexpected error occurred",
): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new AppError(defaultCode, defaultMessage, 500, {
    originalError: message,
  });
}

/**
 * Create error handler middleware wrapper
 *
 * @example
 * ```typescript
 * export const POST = withErrorHandler(async (req: NextRequest) => {
 *   // ... handler logic
 *   throw new ValidationError('Invalid input');
 * });
 * ```
 */
export function withErrorHandler<T extends (...args: any[]) => Promise<any>>(
  handler: T,
  defaultCode?: ErrorCode,
) {
  return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    try {
      return await handler(...args);
    } catch (error) {
      throw toAppError(error, defaultCode);
    }
  };
}

// Re-export withApiErrorHandler from error-handler for convenience
export { withApiErrorHandler } from "./error-handler";

// ============================================================================
// RESULT PATTERN (Standardized service return types)
// ============================================================================
export {
  ok,
  err,
  errWithCode,
  wrapServiceCall,
  wrapServiceCallSync,
  unwrapResult,
  mapResult,
  chainResult,
  logResult,
  resultToApiResponse,
  type Result,
  type ResultSuccess,
  type ResultFailure,
  type ResultData,
} from "./errors/result-pattern";

// ============================================================================
// HTTP ERROR CLASS & GLOBAL ERROR HANDLER
// ============================================================================
export {
  HttpError,
  withErrorHandler,
  formatErrorResponse,
} from "./errors/http-error";
