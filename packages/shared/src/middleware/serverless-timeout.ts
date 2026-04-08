/**
 * Serverless Timeout Middleware
 *
 * Wraps Next.js API route handlers with a hard timeout using AbortController + Promise.race.
 * Prevents functions from running past serverless platform limits (e.g., Vercel's 10s hobby limit).
 *
 * Usage:
 * ```typescript
 * import { withServerlessTimeout } from '@repo/shared/middleware/serverless-timeout';
 *
 * async function myHandler(req: NextRequest): Promise<NextResponse> {
 *   // ... handler logic
 * }
 *
 * export const POST = withServerlessTimeout(myHandler, 8000);
 * ```
 *
 * The handler receives an AbortSignal via `context.signal` that can be propagated
 * to downstream operations (fetch, database queries, etc.) for cooperative cancellation.
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { NextRequest, NextResponse } from "next/server";
import { Logger } from "../logger";

const logger = new Logger({ serviceName: "serverless-timeout" });

/**
 * Context object passed to the wrapped handler.
 * Contains the AbortSignal for cooperative cancellation of in-flight operations.
 */
export interface TimeoutContext {
  signal: AbortSignal;
}

/**
 * Wraps an API route handler with a hard timeout.
 *
 * When the timeout is exceeded:
 * - The AbortController is aborted, signalling the handler to cancel in-flight work
 * - A 504 Gateway Timeout response is returned with structured JSON
 * - The timeout event is logged with route path, timeoutMs, and timestamp
 *
 * @param handler - The async route handler to wrap
 * @param timeoutMs - Timeout in milliseconds (default: 8000)
 * @returns Wrapped handler that enforces the timeout
 *
 * @example
 * ```typescript
 * // Basic usage with default 8s timeout
 * export const POST = withServerlessTimeout(async (req) => {
 *   return NextResponse.json({ data: "ok" });
 * });
 *
 * // With custom timeout and signal propagation
 * export const POST = withServerlessTimeout(async (req, ctx) => {
 *   const result = await fetchExternalApi(req.url, { signal: ctx.signal });
 *   return NextResponse.json({ data: result });
 * }, 5000);
 * ```
 */
export function withServerlessTimeout(
  handler: (
    req: NextRequest,
    context?: TimeoutContext,
  ) => Promise<NextResponse>,
  timeoutMs: number = 8000,
): (req: NextRequest, context?: TimeoutContext) => Promise<NextResponse> {
  return async (
    req: NextRequest,
    context?: TimeoutContext,
  ): Promise<NextResponse> => {
    const abortController = new AbortController();
    const timeoutContext: TimeoutContext = { signal: abortController.signal };

    // Extract route path for logging
    const routePath = req.url ? new URL(req.url).pathname : "unknown";

    // Race between the handler and the timeout
    const timeoutPromise = new Promise<NextResponse>((_, reject) => {
      const timer = setTimeout(() => {
        abortController.abort();
        reject(new TimeoutError(routePath, timeoutMs));
      }, timeoutMs);

      // Clean up timer if handler completes first
      abortController.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
        },
        { once: true },
      );
    });

    try {
      const handlerPromise = handler(req, timeoutContext);
      return await Promise.race([handlerPromise, timeoutPromise]);
    } catch (error) {
      if (error instanceof TimeoutError) {
        return error.toResponse();
      }
      throw error;
    }
  };
}

/**
 * Timeout error with structured response generation.
 */
class TimeoutError extends Error {
  public readonly routePath: string;
  public readonly timeoutMs: number;
  public readonly timestamp: string;

  constructor(routePath: string, timeoutMs: number) {
    super(`Request exceeded ${timeoutMs}ms timeout`);
    this.name = "TimeoutError";
    this.routePath = routePath;
    this.timeoutMs = timeoutMs;
    this.timestamp = new Date().toISOString();
  }

  /**
   * Generate a structured 504 Gateway Timeout response.
   */
  toResponse(): NextResponse {
    const body = {
      error: "Gateway Timeout",
      message: `Request exceeded ${this.timeoutMs}ms timeout`,
      timeoutMs: this.timeoutMs,
      timestamp: this.timestamp,
    };

    // Log the timeout event with structured data
    logger.error("Request timed out", {
      routePath: this.routePath,
      timeoutMs: this.timeoutMs,
      timestamp: this.timestamp,
    });

    return NextResponse.json(body, { status: 504 });
  }
}
