/**
 * API Response Utilities
 *
 * Standardized API response formatting and utilities.
 * Ensures consistent response structure across all endpoints.
 *
 * @see Phase 1.3: API Validation & Standardization
 */

import { ErrorCode } from './errors';
import type { ApiErrorResponse, ApiSuccessResponse } from './error-handler';

// ============================================================================
// RESPONSE OPTIONS
// ============================================================================

export interface ApiResponseOptions {
  /** Trace ID for request tracking */
  traceId?: string;
  /** Idempotency key if provided */
  idempotencyKey?: string;
  /** Custom timestamp (default: now) */
  timestamp?: string;
}

export interface SuccessResponseOptions<T> extends ApiResponseOptions {
  /** Success message */
  message?: string;
  /** Response data */
  data?: T;
}

export interface ErrorResponseOptions extends ApiResponseOptions {
  /** Error details */
  details?: Record<string, unknown>;
  /** Include stack trace (development only) */
  includeStack?: boolean;
}

// ============================================================================
// SUCCESS RESPONSES
// ============================================================================

/**
 * Create standardized success response
 *
 * @param data - Response payload
 * @param options - Response options
 * @returns Formatted success response
 *
 * @example
 * ```typescript
 * return json(successResponse({ bookingId: '123' }, { message: 'Booking confirmed' }));
 * ```
 */
export function successResponse<T = unknown>(
  data?: T,
  options: SuccessResponseOptions<T> = {}
): ApiSuccessResponse<T> {
  const { message, traceId, idempotencyKey, timestamp } = options;

  return {
    success: true,
    ...(data !== undefined && { data }),
    ...(message && { message }),
    timestamp: timestamp || new Date().toISOString(),
    ...(traceId && { traceId }),
    ...(idempotencyKey && { idempotencyKey }),
  };
}

/**
 * Create standardized created response (201)
 */
export function createdResponse<T = unknown>(
  data: T,
  options: SuccessResponseOptions<T> = {}
): ApiSuccessResponse<T> {
  return successResponse(data, { ...options, message: options.message || 'Resource created successfully' });
}

/**
 * Create standardized no-content response (204)
 */
export function noContentResponse(options: ApiResponseOptions = {}): { success: true; timestamp: string } {
  return {
    success: true,
    timestamp: options.timestamp || new Date().toISOString(),
    ...(options.traceId && { traceId: options.traceId }),
  };
}

// ============================================================================
// ERROR RESPONSES
// ============================================================================

/**
 * Create standardized error response
 *
 * @param code - Error code
 * @param message - Error message
 * @param options - Error options
 * @returns Formatted error response
 *
 * @example
 * ```typescript
 * return json(errorResponse('NOT_FOUND', 'Restaurant not found'), { status: 404 });
 * ```
 */
export function errorResponse(
  code: ErrorCode | string,
  message: string,
  options: ErrorResponseOptions = {}
): ApiErrorResponse {
  const { details, includeStack, traceId, idempotencyKey, timestamp } = options;
  const isDevelopment = process.env.NODE_ENV !== 'production';

  return {
    success: false,
    error: {
      code,
      message,
      ...(details && { details }),
      ...(includeStack && isDevelopment && { stack: new Error(message).stack }),
    },
    timestamp: timestamp || new Date().toISOString(),
    ...(traceId && { traceId }),
    ...(idempotencyKey && { idempotencyKey }),
  };
}

/**
 * Create validation error response (400)
 */
export function validationErrorResponse(
  message: string = 'Validation failed',
  details?: Record<string, unknown>,
  options: ErrorResponseOptions = {}
): ApiErrorResponse {
  return errorResponse('VALIDATION_ERROR', message, { ...options, details });
}

/**
 * Create unauthorized error response (401)
 */
export function unauthorizedErrorResponse(
  message: string = 'Unauthorized',
  options: ErrorResponseOptions = {}
): ApiErrorResponse {
  return errorResponse('UNAUTHORIZED', message, options);
}

/**
 * Create forbidden error response (403)
 */
export function forbiddenErrorResponse(
  message: string = 'Forbidden',
  options: ErrorResponseOptions = {}
): ApiErrorResponse {
  return errorResponse('FORBIDDEN', message, options);
}

/**
 * Create not found error response (404)
 */
export function notFoundErrorResponse(
  resource?: string,
  identifier?: string,
  options: ErrorResponseOptions = {}
): ApiErrorResponse {
  const message = resource
    ? `${resource}${identifier ? ` "${identifier}"` : ''} not found`
    : 'Resource not found';
  return errorResponse('NOT_FOUND', message, {
    ...options,
    details: { ...(options.details || {}), resource, identifier },
  });
}

/**
 * Create conflict error response (409)
 */
export function conflictErrorResponse(
  message: string,
  details?: Record<string, unknown>,
  options: ErrorResponseOptions = {}
): ApiErrorResponse {
  return errorResponse('CONFLICT', message, { ...options, details });
}

/**
 * Create rate limit error response (429)
 */
export function rateLimitErrorResponse(
  retryAfter?: number,
  options: ErrorResponseOptions = {}
): ApiErrorResponse {
  return errorResponse('RATE_LIMITED', 'Too many requests. Please try again later.', {
    ...options,
    details: { ...(options.details || {}), retryAfter },
  });
}

/**
 * Create internal server error response (500)
 */
export function internalErrorResponse(
  message: string = 'Internal server error',
  options: ErrorResponseOptions = {}
): ApiErrorResponse {
  return errorResponse('DATABASE_ERROR', message, options);
}

// ============================================================================
// PAGINATED RESPONSES
// ============================================================================

export interface PaginatedResponse<T> {
  success: true;
  data: {
    items: T[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasNext: boolean;
      hasPrev: boolean;
    };
  };
  timestamp: string;
  traceId?: string;
}

export interface PaginationOptions {
  page: number;
  limit: number;
  total: number;
}

/**
 * Create standardized paginated response
 */
export function paginatedResponse<T>(
  items: T[],
  pagination: PaginationOptions,
  options: ApiResponseOptions = {}
): PaginatedResponse<T> {
  const { page, limit, total } = pagination;
  const totalPages = Math.ceil(total / limit);

  return {
    success: true,
    data: {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    },
    timestamp: options.timestamp || new Date().toISOString(),
    ...(options.traceId && { traceId: options.traceId }),
  };
}

// ============================================================================
// HEALTH CHECK RESPONSES
// ============================================================================

export interface HealthResponse {
  status: 'healthy' | 'unhealthy' | 'degraded';
  service: string;
  version: string;
  timestamp: string;
  responseTimeMs: number;
  checks?: HealthCheck[];
}

export interface HealthCheck {
  name: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  responseTimeMs?: number;
  details?: Record<string, unknown>;
}

/**
 * Create health check response
 */
export function healthResponse(
  status: HealthResponse['status'],
  checks: HealthCheck[],
  options: { service?: string; responseTimeMs?: number } = {}
): HealthResponse {
  const { service = 'api', responseTimeMs = 0 } = options;

  return {
    status,
    service,
    version: process.env.npm_package_version || 'unknown',
    timestamp: new Date().toISOString(),
    responseTimeMs,
    checks,
  };
}

/**
 * Create readiness check response
 */
export function readinessResponse(
  ready: boolean,
  reason?: string
): { ready: boolean; timestamp: string; reason?: string } {
  return {
    ready,
    timestamp: new Date().toISOString(),
    ...(reason && { reason }),
  };
}

// ============================================================================
// WEBHOOK RESPONSES
// ============================================================================

export interface WebhookResponse {
  success: boolean;
  eventId: string;
  eventType: string;
  timestamp: string;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Create webhook delivery response
 */
export function webhookResponse(
  eventId: string,
  eventType: string,
  success: boolean,
  error?: { code: string; message: string }
): WebhookResponse {
  return {
    success,
    eventId,
    eventType,
    timestamp: new Date().toISOString(),
    ...(error && { error }),
  };
}

// Type re-exports (functions are already exported inline)
export type {
  ApiResponseOptions,
  SuccessResponseOptions,
  ErrorResponseOptions,
  PaginatedResponse,
  PaginationOptions,
  HealthResponse,
  HealthCheck,
  WebhookResponse,
};
