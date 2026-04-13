/**
 * Error Factory
 *
 * Centralized error creation utilities for the intention engine and table stack.
 * Replaces generic `new Error()` calls with properly typed AppError instances
 * that include ErrorCode, category, and structured metadata.
 *
 * Usage:
 * ```typescript
 * import { EngineError } from "@tablestack/lib/error-factory";
 *
 * // Instead of: throw new Error("Plan not found");
 * throw EngineError.planNotFound(planId);
 *
 * // Instead of: throw new Error("Invalid state");
 * throw EngineError.invalidState("expected EXECUTING, got COMPLETED");
 * ```
 *
 * @see Task 4: Centralize Error Factory
 */

import {
  AppError,
  ValidationError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ErrorCode,
} from "@repo/shared/errors";

// ============================================================================
// ERROR CATEGORIES
// ============================================================================

export type ErrorCategory = "client" | "server" | "business";

/**
 * Map an HTTP status code to an error category
 */
export function categorizeError(statusCode: number): ErrorCategory {
  if (statusCode >= 400 && statusCode < 500) {
    return "client";
  }
  if (statusCode === 409 || statusCode === 422) {
    return "business";
  }
  return "server";
}

// ============================================================================
// ENGINE ERRORS
// Specific to the intention engine domain
// ============================================================================

export class EngineError {
  /**
   * Plan generation failed
   */
  static planGenerationFailed(
    message: string,
    details?: Record<string, unknown>,
  ): AppError {
    return new AppError(ErrorCode.EXECUTION_FAILED, message, 500, details);
  }

  /**
   * Plan validation failed
   */
  static planValidationFailed(
    message: string,
    details?: Record<string, unknown>,
  ): AppError {
    return new AppError(ErrorCode.VALIDATION_ERROR, message, 400, details);
  }

  /**
   * Tool execution failed
   */
  static toolExecutionFailed(
    toolName: string,
    message: string,
    details?: Record<string, unknown>,
  ): AppError {
    return new AppError(
      ErrorCode.EXECUTION_FAILED,
      `Tool '${toolName}' failed: ${message}`,
      500,
      { toolName, ...details },
    );
  }

  /**
   * Tool timeout
   */
  static toolTimeout(toolName: string, timeoutMs: number): AppError {
    return new AppError(
      ErrorCode.TIMEOUT,
      `Tool '${toolName}' timed out after ${timeoutMs}ms`,
      408,
      { toolName, timeoutMs },
    );
  }

  /**
   * Circular dependency detected in plan
   */
  static circularDependency(cycle: string): AppError {
    return new AppError(
      ErrorCode.VALIDATION_ERROR,
      `Circular dependency detected in plan: ${cycle}`,
      400,
      { cycle },
    );
  }

  /**
   * Invalid state transition
   */
  static invalidStateTransition(
    from: string,
    to: string,
    reason: string,
  ): AppError {
    return new AppError(
      ErrorCode.STATE_TRANSITION_INVALID,
      `Invalid state transition from '${from}' to '${to}': ${reason}`,
      500,
      { from, to, reason },
    );
  }

  /**
   * Plan not found
   */
  static planNotFound(planId: string): NotFoundError {
    return new NotFoundError("Plan", planId, { planId });
  }

  /**
   * Invalid state
   */
  static invalidState(
    expected: string,
    actual: string,
    context?: Record<string, unknown>,
  ): AppError {
    return new AppError(
      ErrorCode.EXECUTION_FAILED,
      `Expected state '${expected}', but got '${actual}'`,
      500,
      { expected, actual, ...context },
    );
  }

  /**
   * Workflow execution failed
   */
  static workflowFailed(
    workflowId: string,
    stepId: string,
    message: string,
  ): AppError {
    return new AppError(
      ErrorCode.EXECUTION_FAILED,
      `Workflow '${workflowId}' failed at step '${stepId}': ${message}`,
      500,
      { workflowId, stepId },
    );
  }

  /**
   * Compensation failed
   */
  static compensationFailed(
    stepId: string,
    compensationTool: string,
    message: string,
  ): AppError {
    return new AppError(
      ErrorCode.SAGA_COMPENSATION_FAILED,
      `Compensation for step '${stepId}' using '${compensationTool}' failed: ${message}`,
      500,
      { stepId, compensationTool },
    );
  }

  /**
   * Budget exceeded
   */
  static budgetExceeded(
    limit: number,
    current: number,
    budgetType: "tokens" | "cost",
  ): AppError {
    return new AppError(
      ErrorCode.RATE_LIMITED,
      `${budgetType === "tokens" ? "Token" : "Cost"} limit exceeded: ${current} / ${limit}`,
      429,
      { limit, current, budgetType },
    );
  }

  /**
   * LLM API error
   */
  static llmApiError(
    provider: string,
    message: string,
    statusCode?: number,
  ): AppError {
    return new AppError(
      ErrorCode.EXTERNAL_SERVICE_ERROR,
      `LLM provider '${provider}' error: ${message}`,
      statusCode || 500,
      { provider },
    );
  }

  /**
   * Memory/storage error
   */
  static memoryError(operation: string, message: string): AppError {
    return new AppError(
      ErrorCode.SERVICE_UNAVAILABLE,
      `Memory ${operation} failed: ${message}`,
      500,
      { operation },
    );
  }
}

// ============================================================================
// TABLE STACK ERRORS
// Specific to the table stack (reservation) domain
// ============================================================================

export class TableStackError {
  /**
   * Restaurant not found
   */
  static restaurantNotFound(restaurantId: string): NotFoundError {
    return new NotFoundError("Restaurant", restaurantId, {
      restaurantId,
    });
  }

  /**
   * Table not available
   */
  static tableNotAvailable(tableId: string, startTime: string): ConflictError {
    return new ConflictError(
      `Table '${tableId}' is not available at ${startTime}`,
      { tableId, startTime },
    );
  }

  /**
   * Reservation not found
   */
  static reservationNotFound(reservationId: string): NotFoundError {
    return new NotFoundError("Reservation", reservationId, {
      reservationId,
    });
  }

  /**
   * Invalid party size
   */
  static invalidPartySize(
    partySize: number,
    min: number,
    max: number,
  ): ValidationError {
    return new ValidationError(
      `Invalid party size: ${partySize}. Must be between ${min} and ${max}`,
      { partySize, min, max },
    );
  }

  /**
   * Reservation already cancelled
   */
  static reservationAlreadyCancelled(reservationId: string): AppError {
    return new AppError(
      ErrorCode.CONFLICT,
      `Reservation '${reservationId}' is already cancelled`,
      400,
      { reservationId },
    );
  }

  /**
   * Shadow restaurant creation failed
   */
  static shadowRestaurantFailed(
    name: string,
    email: string,
    reason: string,
  ): AppError {
    return new AppError(
      ErrorCode.EXECUTION_FAILED,
      `Failed to create shadow restaurant '${name}' (${email}): ${reason}`,
      500,
      { name, email },
    );
  }

  /**
   * Identifier missing (restaurant, table, etc.)
   */
  static identifierMissing(identifierType: string): ValidationError {
    return new ValidationError(`${identifierType} identifier missing`);
  }

  /**
   * Unauthorized restaurant access
   */
  static unauthorizedRestaurantAccess(
    requestedRestaurantId: string,
    authorizedRestaurantId: string,
  ): UnauthorizedError {
    return new UnauthorizedError(
      `Unauthorized access to restaurant '${requestedRestaurantId}'. Authorized for '${authorizedRestaurantId}'`,
      { requestedRestaurantId, authorizedRestaurantId },
    );
  }
}

// ============================================================================
// ERROR CONVERSION UTILITIES
// ============================================================================

/**
 * Convert a generic error to an AppError with proper categorization
 */
export function toAppError(
  error: unknown,
  fallbackCode: ErrorCode = ErrorCode.EXECUTION_FAILED,
  fallbackStatusCode: number = 500,
  context?: Record<string, unknown>,
): AppError {
  // Already an AppError
  if (error instanceof AppError) {
    return error;
  }

  // Generic Error
  if (error instanceof Error) {
    return new AppError(fallbackCode, error.message, fallbackStatusCode, {
      originalError: error.name,
      ...context,
    });
  }

  // Unknown type
  return new AppError(fallbackCode, String(error), fallbackStatusCode, context);
}

/**
 * Assert a condition, throwing an error if false
 */
export function assert(
  condition: unknown,
  error: AppError | Error | string,
): asserts condition {
  if (!condition) {
    if (typeof error === "string") {
      throw new AppError(ErrorCode.EXECUTION_FAILED, error, 500);
    }
    throw error;
  }
}

/**
 * Assert not null/undefined, throwing an error if null
 */
export function assertNotNull<T>(
  value: T | null | undefined,
  message: string,
): T {
  if (value === null || value === undefined) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, message, 500);
  }
  return value;
}
