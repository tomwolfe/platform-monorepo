/**
 * Cron Authentication Middleware
 *
 * Provides secure authentication for cron/scheduled job endpoints.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * Usage:
 * ```typescript
 * import { withCronAuth } from '@repo/shared';
 *
 * export const GET = withCronAuth(async (req) => {
 *   // Cron job logic
 *   return NextResponse.json({ success: true });
 * });
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { NextRequest, NextResponse } from 'next/server';
import { isTimingSafeEqual } from '../utils/crypto';

// ============================================================================
// TYPES
// ============================================================================

export interface CronAuthOptions {
  /** Custom secret override (defaults to CRON_SECRET env var) */
  secret?: string;
  /** Custom error message for unauthorized access */
  errorMessage?: string;
  /** Enable debug logging */
  debug?: boolean;
}

export interface CronAuthResult {
  /** Whether authentication was successful */
  authenticated: boolean;
  /** Error response if authentication failed */
  errorResponse?: NextResponse;
}

// ============================================================================
// CRON AUTH MIDDLEWARE
// ============================================================================

/**
 * Verify cron authentication from request headers
 *
 * @param req - Next.js request object
 * @param options - Cron auth options
 * @returns Authentication result
 */
export function verifyCronAuth(
  req: NextRequest,
  options: CronAuthOptions = {}
): CronAuthResult {
  const {
    secret = process.env.CRON_SECRET,
    errorMessage = 'Unauthorized',
    debug = false,
  } = options;

  const authHeader = req.headers.get('authorization');

  // Check for Bearer token format
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    if (debug) {
      console.log('[CronAuth] Missing or invalid authorization header');
    }
    return {
      authenticated: false,
      errorResponse: NextResponse.json(
        { error: 'Missing or invalid authorization header' },
        { status: 401 }
      ),
    };
  }

  const providedSecret = authHeader.substring(7); // Remove 'Bearer ' prefix

  // Validate secret exists
  if (!secret) {
    if (debug) {
      console.warn('[CronAuth] CRON_SECRET not configured in environment');
    }
    return {
      authenticated: false,
      errorResponse: NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      ),
    };
  }

  // TIMING-SAFE COMPARISON: Prevents timing attacks on secret validation
  if (!isTimingSafeEqual(providedSecret, secret)) {
    if (debug) {
      console.warn('[CronAuth] Invalid cron secret provided');
    }
    return {
      authenticated: false,
      errorResponse: NextResponse.json(
        { error: errorMessage },
        { status: 401 }
      ),
    };
  }

  return { authenticated: true };
}

/**
 * Higher-order function to wrap cron handlers with authentication
 *
 * @param handler - The cron handler function to wrap
 * @param options - Cron auth options
 * @returns Wrapped handler with authentication
 *
 * @example
 * ```typescript
 * // Basic usage
 * export const GET = withCronAuth(async (req) => {
 *   // Your cron logic here
 *   return NextResponse.json({ success: true });
 * });
 *
 * // With custom options
 * export const POST = withCronAuth(
 *   async (req) => {
 *     // Your cron logic here
 *   },
 *   { debug: true }
 * );
 * ```
 */
export function withCronAuth<T extends (...args: any[]) => Promise<NextResponse>>(
  handler: T,
  options: CronAuthOptions = {}
): T {
  return (async (...args: any[]) => {
    const req = args[0] as NextRequest;

    // Verify authentication
    const result = verifyCronAuth(req, options);

    if (!result.authenticated && result.errorResponse) {
      return result.errorResponse;
    }

    // Execute handler
    return await handler(...args);
  }) as T;
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use verifyCronAuth or withCronAuth instead
 */
export function isCronAuthenticated(req: NextRequest): boolean {
  const result = verifyCronAuth(req);
  return result.authenticated;
}
