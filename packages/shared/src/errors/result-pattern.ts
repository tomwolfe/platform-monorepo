/**
 * Result Pattern Utilities
 *
 * Standardizes error handling across all Service Layer methods.
 * Instead of throwing errors, services return Result objects:
 *   - { success: true, data: T }
 *   - { success: false, error: AppError }
 *
 * This eliminates the need for consumers to wrap service calls in try/catch
 * inconsistently, and makes error paths explicit in the type system.
 *
 * Usage:
 * ```typescript
 * // Service method returning Result
 * async function createReservation(data: ReservationInput): Promise<Result<Reservation>> {
 *   try {
 *     const reservation = await db.insert(reservations).values(data).returning();
 *     return { success: true, data: reservation[0] };
 *   } catch (error) {
 *     return { success: false, error: wrapServiceCall(error) };
 *   }
 * }
 *
 * // Consumer
 * const result = await reservationService.createReservation(input);
 * if (!result.success) {
 *   return NextResponse.json({ error: result.error.message }, { status: result.error.statusCode });
 * }
 * const reservation = result.data;
 * ```
 *
 * @package @repo/shared
 */

import { AppError, isAppError, toAppError, ErrorCode } from "../errors";
import { Logger } from "../logger";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Success result with data
 */
export interface ResultSuccess<T> {
  success: true;
  data: T;
}

/**
 * Failure result with error
 */
export interface ResultFailure {
  success: false;
  error: AppError;
}

/**
 * Union type for service results
 */
export type Result<T> = ResultSuccess<T> | ResultFailure;

/**
 * Helper type to extract the success data type from a Result
 */
export type ResultData<R> = R extends ResultSuccess<infer T> ? T : never;

// ============================================================================
// CORE UTILITIES
// ============================================================================

/**
 * Create a success result
 */
export function ok<T>(data: T): ResultSuccess<T> {
  return { success: true, data };
}

/**
 * Create a failure result
 */
export function err(error: AppError | Error | unknown): ResultFailure {
  if (error instanceof AppError) {
    return { success: false, error };
  }
  return { success: false, error: toAppError(error) };
}

/**
 * Create a failure result with a specific error code
 */
export function errWithCode(
  code: ErrorCode,
  message: string,
  statusCode?: number,
  details?: Record<string, unknown>,
): ResultFailure {
  return {
    success: false,
    error: new AppError(code, message, statusCode, details),
  };
}

/**
 * Wrap a service call that may throw into a Result object.
 *
 * Converts thrown AppErrors into { success: false, error: AppError } results.
 * Non-AppError exceptions are converted to AppErrors via toAppError.
 *
 * Use this to wrap any service method call that throws:
 * ```typescript
 * const result = wrapServiceCall(() => service.doSomething());
 * ```
 *
 * @param fn - Async function that may throw
 * @returns Result object
 */
export async function wrapServiceCall<T>(
  fn: () => Promise<T>,
): Promise<Result<T>> {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (error) {
    return err(error);
  }
}

/**
 * Synchronous version of wrapServiceCall
 */
export function wrapServiceCallSync<T>(fn: () => T): Result<T> {
  try {
    const data = fn();
    return { success: true, data };
  } catch (error) {
    return err(error);
  }
}

/**
 * Unwrap a Result, returning the data or throwing the error.
 *
 * Use this when you want to work with the data directly and
 * prefer to handle errors at a higher level:
 * ```typescript
 * const data = unwrapResult(result); // throws if failed
 * ```
 *
 * @param result - Result object
 * @returns The data if successful
 * @throws The error if failed
 */
export function unwrapResult<T>(result: Result<T>): T {
  if (result.success) {
    return result.data;
  }
  throw result.error;
}

/**
 * Map a success result's data through a transformation function.
 * Failure results pass through unchanged.
 *
 * ```typescript
 * const userIdResult = mapResult(createUserResult, (user) => user.id);
 * ```
 */
export function mapResult<T, U>(
  result: Result<T>,
  fn: (data: T) => U,
): Result<U> {
  if (result.success) {
    return { success: true, data: fn(result.data) };
  }
  return result;
}

/**
 * Chain multiple Result-returning operations.
 * Stops at the first failure and returns it.
 *
 * ```typescript
 * const result = chainResult(
 *   () => validateInput(input),
 *   (validated) => createUser(validated),
 *   (user) => sendWelcomeEmail(user),
 * );
 * ```
 */
export async function chainResult<T>(
  ...fns: Array<() => Promise<Result<T>> | Result<T>>
): Promise<Result<T>> {
  for (const fn of fns) {
    const result = fn instanceof Promise ? await fn : fn;
    if (!result.success) {
      return result;
    }
  }
  // This should not be reached if at least one function is provided
  // Return a generic success with undefined
  return { success: true, data: undefined as T };
}

// ============================================================================
// LOGGER INTEGRATION
// ============================================================================

/**
 * Log a Result failure.
 * Useful for service-layer logging without cluttering success paths.
 */
export function logResult(
  logger: Logger,
  result: Result<unknown>,
  context?: string,
): void {
  if (!result.success) {
    logger.error({
      message: context
        ? `Service call failed: ${context}`
        : "Service call failed",
      error: result.error.message,
      code: result.error.code,
      details: result.error.details,
    });
  }
}

// ============================================================================
// API RESPONSE HELPERS
// ============================================================================

/**
 * Convert a Result to a NextResponse JSON response.
 *
 * Success: 200 OK with data
 * Failure: HTTP status based on error's statusCode
 *
 * ```typescript
 * return resultToResponse(result);
 * ```
 */
export function resultToApiResponse(result: Result<any>): {
  body: Record<string, unknown>;
  status: number;
} {
  if (result.success) {
    return {
      body: { success: true, data: result.data },
      status: 200,
    };
  }

  return {
    body: {
      success: false,
      error: {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.details && { details: result.error.details }),
      },
    },
    status: result.error.statusCode,
  };
}
