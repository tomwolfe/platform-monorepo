/**
 * Standardized HTTP Error Code Mapping
 *
 * Maps internal error codes to HTTP status codes with retryability metadata.
 * This ensures all API responses include consistent, grep-friendly error codes.
 *
 * Usage:
 * ```typescript
 * import { HTTP_ERROR_MAP, getErrorMetadata } from '@repo/shared/errors/http-codes';
 *
 * const metadata = getErrorMetadata('VALIDATION_ERROR');
 * // { statusCode: 400, retryable: false, category: 'client' }
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { ErrorCode } from "../errors";

// ============================================================================
// ERROR METADATA
// ============================================================================

/**
 * Error category for client-side handling
 */
export type ErrorCategory = "client" | "server" | "network" | "business";

/**
 * HTTP error metadata for each error code
 */
export interface HttpErrorMetadata {
  /** HTTP status code */
  statusCode: number;
  /** Whether the client should retry the request */
  retryable: boolean;
  /** Error category for client-side handling */
  category: ErrorCategory;
  /** Human-readable description */
  description: string;
}

/**
 * Complete mapping of error codes to HTTP metadata
 */
export const HTTP_ERROR_MAP: Record<ErrorCode, HttpErrorMetadata> = {
  // Validation Errors (400) - Not retryable
  VALIDATION_ERROR: {
    statusCode: 400,
    retryable: false,
    category: "client",
    description: "Request validation failed",
  },
  INVALID_INPUT: {
    statusCode: 400,
    retryable: false,
    category: "client",
    description: "Invalid input provided",
  },
  MISSING_REQUIRED_FIELD: {
    statusCode: 400,
    retryable: false,
    category: "client",
    description: "Required field is missing",
  },
  INVALID_FORMAT: {
    statusCode: 400,
    retryable: false,
    category: "client",
    description: "Invalid input format",
  },

  // Authentication Errors (401, 403) - Retryable only if token refresh possible
  UNAUTHORIZED: {
    statusCode: 401,
    retryable: false,
    category: "client",
    description: "Authentication required",
  },
  INVALID_TOKEN: {
    statusCode: 401,
    retryable: false,
    category: "client",
    description: "Invalid authentication token",
  },
  TOKEN_EXPIRED: {
    statusCode: 401,
    retryable: true,
    category: "client",
    description: "Authentication token has expired",
  },
  FORBIDDEN: {
    statusCode: 403,
    retryable: false,
    category: "client",
    description: "Insufficient permissions",
  },
  INSUFFICIENT_PERMISSIONS: {
    statusCode: 403,
    retryable: false,
    category: "client",
    description: "User lacks required permissions",
  },

  // Resource Errors (404, 409) - Not retryable
  NOT_FOUND: {
    statusCode: 404,
    retryable: false,
    category: "client",
    description: "Resource not found",
  },
  CONFLICT: {
    statusCode: 409,
    retryable: false,
    category: "client",
    description: "Request conflicts with current state",
  },
  ALREADY_EXISTS: {
    statusCode: 409,
    retryable: false,
    category: "client",
    description: "Resource already exists",
  },
  RESOURCE_UNAVAILABLE: {
    statusCode: 409,
    retryable: false,
    category: "client",
    description: "Resource is currently unavailable",
  },

  // Rate Limiting (429) - Retryable with backoff
  RATE_LIMITED: {
    statusCode: 429,
    retryable: true,
    category: "network",
    description: "Rate limit exceeded, retry after backoff",
  },

  // Execution Errors (500+) - Some retryable
  EXECUTION_FAILED: {
    statusCode: 500,
    retryable: false,
    category: "server",
    description: "Internal execution failure",
  },
  TIMEOUT: {
    statusCode: 504,
    retryable: true,
    category: "network",
    description: "Operation timed out",
  },
  SERVICE_UNAVAILABLE: {
    statusCode: 503,
    retryable: true,
    category: "server",
    description: "Service temporarily unavailable",
  },
  DATABASE_ERROR: {
    statusCode: 500,
    retryable: false,
    category: "server",
    description: "Database operation failed",
  },
  EXTERNAL_SERVICE_ERROR: {
    statusCode: 500,
    retryable: true,
    category: "network",
    description: "External service call failed",
  },

  // Saga/Workflow Errors - Retryable
  SAGA_COMPENSATION_FAILED: {
    statusCode: 500,
    retryable: false,
    category: "server",
    description: "Saga compensation failed",
  },
  STATE_TRANSITION_INVALID: {
    statusCode: 500,
    retryable: false,
    category: "server",
    description: "Invalid state transition",
  },

  // Business Logic Errors - Not retryable
  BUSINESS_RULE_VIOLATION: {
    statusCode: 400,
    retryable: false,
    category: "business",
    description: "Business rule was violated",
  },
  CLARIFICATION_REQUIRED: {
    statusCode: 400,
    retryable: false,
    category: "business",
    description: "User clarification is required",
  },
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get HTTP metadata for an error code
 *
 * @param code - Error code
 * @returns HTTP error metadata
 */
export function getErrorMetadata(code: ErrorCode): HttpErrorMetadata {
  return (
    HTTP_ERROR_MAP[code] || {
      statusCode: 500,
      retryable: false,
      category: "server",
      description: "Unknown error",
    }
  );
}

/**
 * Create an API error response with standardized structure
 *
 * @param code - Machine-readable error code
 * @param message - Human-readable error message
 * @param traceId - Request trace ID for debugging
 * @param details - Optional additional context
 * @returns Standardized API error response
 */
export function createStandardApiErrorResponse(
  code: ErrorCode,
  message: string,
  traceId?: string,
  details?: Record<string, unknown>,
): {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    category: ErrorCategory;
    details?: Record<string, unknown>;
  };
  traceId?: string;
} {
  const metadata = getErrorMetadata(code);

  return {
    success: false,
    error: {
      code,
      message,
      retryable: metadata.retryable,
      category: metadata.category,
      ...(details && Object.keys(details).length > 0 && { details }),
    },
    ...(traceId && { traceId }),
  };
}

/**
 * Extract trace ID from a request object
 *
 * @param req - Request or headers container
 * @returns Trace ID or undefined
 */
export function extractTraceIdFromRequest(
  req: { headers?: { get: (name: string) => string | null } } | undefined,
): string | undefined {
  return req?.headers?.get?.("x-trace-id") || undefined;
}
