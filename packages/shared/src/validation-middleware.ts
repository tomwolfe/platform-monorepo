/**
 * Request Validation Middleware
 *
 * Provides middleware for validating API requests with Zod schemas.
 * Includes rate limiting, request logging, and standardized error handling.
 *
 * @see Phase 1.3: API Validation & Standardization
 */

import { z } from 'zod';
import { Logger } from './logger';
import { formatValidationError } from './api-schemas';
import { errorResponse, validationErrorResponse } from './api-response';

// ============================================================================
// TYPES
// ============================================================================

export interface ValidationMiddlewareOptions {
  /** Logger instance */
  logger?: Logger;
  /** Service name for logging */
  serviceName?: string;
  /** Enable request body logging (development only) */
  logBody?: boolean;
  /** Custom error messages */
  errorMessages?: Record<string, string>;
  /** Strip unknown fields from request */
  stripUnknown?: boolean;
  /** Transform request data before validation */
  transform?: (data: unknown) => unknown;
}

export interface RateLimitOptions {
  /** Maximum requests per window */
  limit: number;
  /** Window size in seconds */
  windowSeconds: number;
  /** Rate limit key generator */
  keyGenerator?: (req: Request) => string;
  /** Skip rate limiting for certain requests */
  skip?: (req: Request) => boolean;
}

// ============================================================================
// VALIDATION MIDDLEWARE
// ============================================================================

/**
 * Create validation middleware for a Zod schema
 *
 * @param schema - Zod schema to validate against
 * @param options - Middleware options
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * const validateReserve = createValidationMiddleware(ReserveRequestSchema);
 *
 * export const POST = async (req: Request) => {
 *   const validation = await validateReserve(req);
 *   if (!validation.valid) {
 *     return Response.json(validation.error, { status: 400 });
 *   }
 *   // validation.data is typed as ReserveRequest
 *   return handleReservation(validation.data);
 * };
 * ```
 */
export function createValidationMiddleware<T extends z.ZodType>(
  schema: T,
  options: ValidationMiddlewareOptions = {}
) {
  const {
    logger = new Logger({ serviceName: options.serviceName || 'validation' }),
    logBody = process.env.NODE_ENV !== 'production',
    stripUnknown = false,
    transform,
  } = options;

  return async (req: Request): Promise<
    | { valid: true; data: z.infer<T> }
    | { valid: false; error: ReturnType<typeof formatValidationError>; status: number }
  > => {
    const requestId = logger.requestStart({
      method: req.method,
      path: req.url,
      headers: req.headers,
    });

    try {
      // Parse request body
      let data: unknown;
      const contentType = req.headers.get('content-type');

      if (contentType?.includes('application/json')) {
        const bodyText = await req.text();
        if (logBody) {
          logger.debug('Request body received', { body: bodyText.substring(0, 500) });
        }
        try {
          data = JSON.parse(bodyText);
        } catch (parseError) {
          logger.requestEnd(requestId, { statusCode: 400, durationMs: 0 });
          return {
            valid: false,
            error: formatValidationError(
              new z.ZodError([{
                code: 'custom',
                message: 'Invalid JSON format',
                path: [],
              }])
            ),
            status: 400,
          };
        }
      } else if (req.method === 'GET') {
        const url = new URL(req.url);
        data = Object.fromEntries(url.searchParams.entries());
      } else {
        data = await req.text();
      }

      // Apply transformation if provided
      if (transform) {
        data = transform(data);
      }

      // Validate with schema
      const result = stripUnknown
        ? schema.strip().safeParse(data)
        : schema.safeParse(data);

      if (!result.success) {
        logger.requestEnd(requestId, { statusCode: 400, durationMs: 0 });
        logger.warn('Validation failed', {
          errors: result.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
        });

        return {
          valid: false,
          error: formatValidationError(result.error),
          status: 400,
        };
      }

      logger.requestEnd(requestId, { statusCode: 200, durationMs: 0 });
      return { valid: true, data: result.data };
    } catch (error) {
      logger.requestEnd(requestId, { statusCode: 500, durationMs: 0 });
      logger.error('Validation middleware error', { error: error instanceof Error ? error.message : String(error) });

      return {
        valid: false,
        error: formatValidationError(
          new z.ZodError([{
            code: 'custom',
            message: error instanceof Error ? error.message : 'Validation failed',
            path: [],
          }])
        ),
        status: 500,
      };
    }
  };
}

// ============================================================================
// RATE LIMITING MIDDLEWARE
// ============================================================================

/**
 * Create rate limiting middleware
 *
 * @param options - Rate limit configuration
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * const rateLimit = createRateLimitMiddleware({
 *   limit: 100,
 *   windowSeconds: 60,
 *   keyGenerator: (req) => req.headers.get('x-forwarded-for') || 'anonymous',
 * });
 * ```
 */
export function createRateLimitMiddleware(options: RateLimitOptions) {
  const {
    limit,
    windowSeconds,
    keyGenerator = (req) => req.headers.get('x-forwarded-for') || 'anonymous',
    skip,
  } = options;

  // In-memory store for rate limits (use Redis for production)
  const requestCounts = new Map<string, { count: number; resetTime: number }>();

  return async (req: Request): Promise<
    | { allowed: true; remaining: number; resetTime: number }
    | { allowed: false; remaining: 0; resetTime: number; retryAfter: number }
  > => {
    // Skip rate limiting if configured
    if (skip?.(req)) {
      return { allowed: true, remaining: limit, resetTime: Date.now() + windowSeconds * 1000 };
    }

    const key = keyGenerator(req);
    const now = Date.now();
    const windowMs = windowSeconds * 1000;

    const record = requestCounts.get(key);

    if (!record || now > record.resetTime) {
      // New window
      requestCounts.set(key, { count: 1, resetTime: now + windowMs });
      return { allowed: true, remaining: limit - 1, resetTime: now + windowMs };
    }

    if (record.count >= limit) {
      // Rate limit exceeded
      const retryAfter = Math.ceil((record.resetTime - now) / 1000);
      return { allowed: false, remaining: 0, resetTime: record.resetTime, retryAfter };
    }

    // Increment count
    record.count++;
    return { allowed: true, remaining: limit - record.count, resetTime: record.resetTime };
  };
}

// ============================================================================
// COMPOSED MIDDLEWARE
// ============================================================================

/**
 * Compose multiple middleware functions
 *
 * @param middlewares - Array of middleware functions
 * @returns Composed middleware
 *
 * @example
 * ```typescript
 * const apiMiddleware = composeMiddleware([
 *   createRateLimitMiddleware({ limit: 100, windowSeconds: 60 }),
 *   createValidationMiddleware(ReserveRequestSchema),
 * ]);
 * ```
 */
export function composeMiddleware<T>(
  middlewares: Array<(req: Request) => Promise<T | null>>
): (req: Request) => Promise<T | null> {
  return async (req: Request) => {
    for (const middleware of middlewares) {
      const result = await middleware(req);
      if (result !== null) {
        return result;
      }
    }
    return null;
  };
}

// ============================================================================
// REQUEST UTILITIES
// ============================================================================

/**
 * Extract bearer token from Authorization header
 */
export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
}

/**
 * Extract API key from header
 */
export function extractApiKey(req: Request): string | null {
  return req.headers.get('x-api-key');
}

/**
 * Get client IP from request
 */
export function getClientIP(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0] ||
    req.headers.get('x-real-ip') ||
    'unknown'
  );
}

/**
 * Check if request accepts JSON
 */
export function acceptsJson(req: Request): boolean {
  const accept = req.headers.get('accept');
  return accept?.includes('application/json') || accept?.includes('*/*') || false;
}

// Value exports
export {
  createValidationMiddleware,
  createRateLimitMiddleware,
  composeMiddleware,
  extractBearerToken,
  extractApiKey,
  getClientIP,
  acceptsJson,
};

// Type re-exports
export type {
  ValidationMiddlewareOptions,
  RateLimitOptions,
};
