/**
 * Unified HTTP Response Factory
 *
 * Standardizes all API responses to a single, Zod-validated schema.
 * Eliminates ad-hoc NextResponse.json() patterns across route handlers.
 *
 * Response Shape:
 * - Success: { success: true, data?, traceId?, timestamp? }
 * - Error:   { success: false, error: { code, message, details?, fields? }, traceId?, timestamp? }
 *
 * @package @repo/shared
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getTraceId } from "../tracing";

// ============================================================================
// RESPONSE SCHEMAS
// ============================================================================

/**
 * Zod schema for field-level validation errors
 */
export const ApiErrorFieldSchema = z.record(z.string());

/**
 * Zod schema for API error responses
 */
export const ApiErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
    fields: ApiErrorFieldSchema.optional(),
  }),
  traceId: z.string().optional(),
  timestamp: z.string().optional(),
});

/**
 * Zod schema for API success responses
 */
export const ApiSuccessResponseSchema = <T extends z.ZodType>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema.optional(),
    traceId: z.string().optional(),
    timestamp: z.string().optional(),
  });

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
export type ApiSuccessResponse<T = unknown> = {
  success: true;
  data?: T;
  traceId?: string;
  timestamp?: string;
};

// ============================================================================
// RESPONSE FACTORIES
// ============================================================================

/**
 * Get current trace ID from request context
 */
function getCurrentTraceId(): string | undefined {
  try {
    return getTraceId();
  } catch {
    return undefined;
  }
}

/**
 * Create a standardized success response
 */
export function successResponse<T>(
  data?: T,
  options?: { traceId?: string },
): ApiSuccessResponse<T> {
  return {
    success: true,
    data,
    traceId: options?.traceId || getCurrentTraceId(),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create a standardized error response
 */
export function errorResponse(
  code: string,
  message: string,
  options?: {
    statusCode?: number;
    details?: unknown;
    fields?: Record<string, string>;
    traceId?: string;
  },
): ApiErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      ...(options?.details && { details: options.details }),
      ...(options?.fields && { fields: options.fields }),
    },
    traceId: options?.traceId || getCurrentTraceId(),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format Zod validation errors into field-level error response
 */
export function formatZodError(
  zodError: z.ZodError,
  options?: { traceId?: string },
): ApiErrorResponse {
  const fields: Record<string, string> = {};

  zodError.errors.forEach((err) => {
    const path = err.path.join(".");
    if (path) {
      fields[path] = err.message;
    }
  });

  return errorResponse("VALIDATION_ERROR", "Validation failed", {
    statusCode: 400,
    details: {
      issues: zodError.errors.map((err) => ({
        path: err.path,
        message: err.message,
        code: err.code,
      })),
    },
    fields,
    traceId: options?.traceId,
  });
}

// ============================================================================
// NEXT.JS RESPONSE HELPERS
// ============================================================================

/**
 * Create a NextResponse with standardized success shape
 */
export function jsonSuccess<T>(
  data?: T,
  options?: {
    status?: number;
    headers?: Record<string, string>;
    traceId?: string;
  },
): NextResponse {
  const body = successResponse(data, { traceId: options?.traceId });
  return NextResponse.json(body, {
    status: options?.status || 200,
    headers: options?.headers,
  });
}

/**
 * Create a NextResponse with standardized error shape
 */
export function jsonError(
  code: string,
  message: string,
  options?: {
    statusCode?: number;
    details?: unknown;
    fields?: Record<string, string>;
    traceId?: string;
  },
): NextResponse {
  const body = errorResponse(code, message, options);
  return NextResponse.json(body, {
    status: options?.statusCode || 500,
  });
}
