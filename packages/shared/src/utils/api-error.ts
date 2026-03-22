/**
 * API Error Formatting Utilities
 *
 * Standardizes error responses across all API routes in the monorepo.
 * Ensures consistent error structure for frontend and external service integration.
 *
 * Usage:
 * ```typescript
 * import { formatApiError, createApiError } from "@repo/shared";
 *
 * // In API route
 * export async function POST(req: NextRequest) {
 *   try {
 *     // ... logic
 *   } catch (error) {
 *     return NextResponse.json(formatApiError(error, "DATABASE_ERROR"));
 *   }
 * }
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";

/**
 * Standard API error response structure
 */
export interface ApiErrorResponse {
  success: false;
  error: {
    /** Machine-readable error code for programmatic handling */
    code: string;
    /** Human-readable error message */
    message: string;
    /** Optional detailed error information */
    details?: unknown;
    /** Optional field-specific errors (for validation errors) */
    fields?: Record<string, string>;
  };
}

/**
 * Standard API success response structure
 */
export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  metadata?: {
    /** Request trace ID for debugging */
    traceId?: string;
    /** Duration in milliseconds */
    durationMs?: number;
    /** Additional metadata */
    [key: string]: unknown;
  };
}

/**
 * Common engine error codes for standardized error handling
 */
export const EngineErrorCodes = {
  // Validation Errors (4xx)
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INTENT_VALIDATION_FAILED: "INTENT_VALIDATION_FAILED",
  PLAN_VALIDATION_FAILED: "PLAN_VALIDATION_FAILED",
  PARAMETER_VALIDATION_FAILED: "PARAMETER_VALIDATION_FAILED",

  // Authentication Errors (4xx)
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  INVALID_TOKEN: "INVALID_TOKEN",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",

  // Resource Errors (4xx)
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  ALREADY_EXISTS: "ALREADY_EXISTS",

  // Execution Errors (5xx)
  EXECUTION_FAILED: "EXECUTION_FAILED",
  TOOL_EXECUTION_FAILED: "TOOL_EXECUTION_FAILED",
  TIMEOUT: "TIMEOUT",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",

  // System Errors (5xx)
  INTERNAL_ERROR: "INTERNAL_ERROR",
  DATABASE_ERROR: "DATABASE_ERROR",
  EXTERNAL_SERVICE_ERROR: "EXTERNAL_SERVICE_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  CONFIGURATION_ERROR: "CONFIGURATION_ERROR",

  // Saga/Workflow Errors
  SAGA_COMPENSATION_FAILED: "SAGA_COMPENSATION_FAILED",
  WORKFLOW_TIMEOUT: "WORKFLOW_TIMEOUT",
  STATE_TRANSITION_INVALID: "STATE_TRANSITION_INVALID",

  // Custom/Application Errors
  CLARIFICATION_REQUIRED: "CLARIFICATION_REQUIRED",
  BUSINESS_RULE_VIOLATION: "BUSINESS_RULE_VIOLATION",
  INSUFFICIENT_PERMISSIONS: "INSUFFICIENT_PERMISSIONS",
} as const;

export type EngineErrorCode = (typeof EngineErrorCodes)[keyof typeof EngineErrorCodes];

/**
 * HTTP status codes mapped to error categories
 */
const ERROR_STATUS_MAP: Record<string, number> = {
  VALIDATION_ERROR: 400,
  INTENT_VALIDATION_FAILED: 400,
  PLAN_VALIDATION_FAILED: 400,
  PARAMETER_VALIDATION_FAILED: 400,
  UNAUTHORIZED: 401,
  INVALID_TOKEN: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  INSUFFICIENT_PERMISSIONS: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ALREADY_EXISTS: 409,
  TIMEOUT: 408,
  RATE_LIMIT_EXCEEDED: 429,
  SERVICE_UNAVAILABLE: 503,
  SAGA_COMPENSATION_FAILED: 500,
  WORKFLOW_TIMEOUT: 504,
  STATE_TRANSITION_INVALID: 500,
  BUSINESS_RULE_VIOLATION: 400,
  CLARIFICATION_REQUIRED: 400,
  // Default to 500 for unknown errors
  INTERNAL_ERROR: 500,
  DATABASE_ERROR: 500,
  EXTERNAL_SERVICE_ERROR: 500,
  CONFIGURATION_ERROR: 500,
  EXECUTION_FAILED: 500,
  TOOL_EXECUTION_FAILED: 500,
};

/**
 * Format an error into a standardized API error response
 *
 * @param error - The error to format (can be Error, string, or unknown)
 * @param code - Optional error code (defaults to INTERNAL_ERROR)
 * @param details - Optional additional details to include
 * @returns Standardized error response object
 *
 * @example
 * ```typescript
 * try {
 *   await db.query(...);
 * } catch (error) {
 *   return NextResponse.json(
 *     formatApiError(error, "DATABASE_ERROR"),
 *     { status: 500 }
 *   );
 * }
 * ```
 */
export function formatApiError(
  error: unknown,
  code: EngineErrorCode = "INTERNAL_ERROR",
  details?: unknown
): ApiErrorResponse {
  const message = extractErrorMessage(error);
  const fields = extractFieldErrors(error);

  return {
    success: false,
    error: {
      code,
      message,
      details: details ?? extractErrorDetails(error),
      ...(fields && { fields }),
    },
  };
}

/**
 * Create a standardized API error response from known error information
 *
 * @param code - Error code
 * @param message - Human-readable message
 * @param details - Optional additional details
 * @returns Standardized error response object
 */
export function createApiError(
  code: EngineErrorCode,
  message: string,
  details?: unknown
): ApiErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      ...(details !== undefined && { details: details as Record<string, unknown> }),
    },
  };
}

/**
 * Format a success response
 *
 * @param data - Response data
 * @param metadata - Optional metadata
 * @returns Standardized success response object
 */
export function formatApiSuccess<T>(
  data: T,
  metadata?: ApiSuccessResponse["metadata"]
): ApiSuccessResponse<T> {
  return {
    success: true,
    data,
    ...(metadata && { metadata }),
  };
}

/**
 * Get the HTTP status code for an error code
 *
 * @param code - Error code
 * @returns HTTP status code
 */
export function getErrorStatusCode(code: string): number {
  return ERROR_STATUS_MAP[code] || 500;
}

/**
 * Extract error message from any error type
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as any).message);
  }
  return "An unexpected error occurred";
}

/**
 * Extract field-specific errors (useful for validation errors)
 */
function extractFieldErrors(error: unknown): Record<string, string> | undefined {
  if (error instanceof z.ZodError) {
    const fields: Record<string, string> = {};
    error.errors.forEach((err) => {
      const path = err.path.join(".");
      if (path) {
        fields[path] = err.message;
      }
    });
    return fields;
  }
  return undefined;
}

/**
 * Extract additional error details
 */
function extractErrorDetails(error: unknown): unknown {
  if (error instanceof z.ZodError) {
    return {
      issues: error.errors.map((err) => ({
        path: err.path,
        message: err.message,
        code: err.code,
      })),
    };
  }
  if (error && typeof error === "object" && !(error instanceof Error)) {
    return error;
  }
  return undefined;
}

/**
 * Wrap an async function with standardized error handling
 *
 * @param fn - Async function to wrap
 * @param errorCode - Default error code to use
 * @returns Wrapped function that returns standardized error responses
 *
 * @example
 * ```typescript
 * export const POST = withApiErrorHandler(
 *   async (req: NextRequest) => {
 *     const body = await req.json();
 *     const result = await someOperation(body);
 *     return NextResponse.json(formatApiSuccess(result));
 *   },
 *   "EXECUTION_FAILED"
 * );
 * ```
 */
export function withApiErrorHandler<T>(
  fn: (req: any) => Promise<T>,
  errorCode: EngineErrorCode = "INTERNAL_ERROR"
) {
  return async (req: any) => {
    try {
      return await fn(req);
    } catch (error) {
      const errorResponse = formatApiError(error, errorCode);
      const status = getErrorStatusCode(errorCode);
      return Response.json(errorResponse, { status });
    }
  };
}

/**
 * Type guard to check if a response is an error response
 */
export function isErrorResponse(
  response: unknown
): response is ApiErrorResponse {
  return (
    typeof response === "object" &&
    response !== null &&
    "success" in response &&
    response.success === false
  );
}

/**
 * Type guard to check if a response is a success response
 */
export function isSuccessResponse<T>(
  response: unknown
): response is ApiSuccessResponse<T> {
  return (
    typeof response === "object" &&
    response !== null &&
    "success" in response &&
    response.success === true
  );
}
