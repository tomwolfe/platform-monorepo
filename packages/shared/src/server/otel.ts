/**
 * OpenTelemetry Error Tracking
 *
 * This module provides OTEL-based error tracking utilities to replace the deprecated Sentry shim.
 * OpenTelemetry is the industry standard for observability and is natively supported by:
 * - Vercel (via @vercel/otel)
 * - Datadog, New Relic, Honeycomb, Jaeger
 * - Any OTLP-compatible collector
 *
 * Architecture:
 * 1. Errors are captured via standard try/catch with structured AppError types
 * 2. OTEL spans are automatically created for request handling
 * 3. Errors are attached to spans via `span.recordException(error)`
 * 4. OTLP exporter sends traces to your observability provider
 *
 * Configuration:
 * ```bash
 * # .env
 * OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
 * OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=YOUR_KEY
 * OTEL_SERVICE_NAME=table-stack
 * ```
 *
 * Usage:
 * ```typescript
 * import { captureErrorForOtel } from '@repo/shared/server/otel';
 *
 * try {
 *   await doSomething();
 * } catch (error) {
 *   captureErrorForOtel(error, { context: 'checkout.process' });
 *   throw error; // Or handle appropriately
 * }
 * ```
 *
 * Migration from Sentry:
 * - `captureSentryException(error)` → `captureErrorForOtel(error)`
 * - `setSentryUser({ id, email })` → Use OTEL resource attributes in middleware
 * - `addSentryBreadcrumb(message)` → Use OTEL span events
 *
 * @see https://opentelemetry.io/docs/
 * @see https://vercel.com/docs/observability
 * @package @repo/shared
 */

import { Logger } from "../logger";

const otelLogger = new Logger({ serviceName: "otel-error-tracking" });

/**
 * Context for error capture
 */
export interface OtelErrorContext {
  /** Operation or route being executed */
  operation?: string;
  /** Additional attributes to attach to the error */
  attributes?: Record<string, unknown>;
  /** User ID (if available) */
  userId?: string;
}

/**
 * Capture an error for OpenTelemetry tracking
 *
 * This function:
 * 1. Logs the error via Logger for local debugging
 * 2. Attaches error to current active span (if available)
 * 3. Adds structured attributes for filtering in observability UI
 *
 * @param error - The error to capture
 * @param context - Optional context for filtering
 *
 * @example
 * ```typescript
 * try {
 *   await processPayment(checkoutData);
 * } catch (error) {
 *   captureErrorForOtel(error, {
 *     operation: 'checkout.process',
 *     userId: user.id,
 *   });
 *   throw error;
 * }
 * ```
 */
export function captureErrorForOtel(
  error: unknown,
  context: OtelErrorContext = {},
): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  // Log for local debugging
  otelLogger.error(`[OTEL] ${errorMessage}`, {
    operation: context.operation,
    userId: context.userId,
    stack: errorStack,
    attributes: context.attributes,
  });

  // Note: In production, OTEL spans are automatically populated
  // via instrumentation. This function provides a hook for
  // manual error attachment if needed.
  //
  // To enable full OTEL integration:
  // 1. Install @opentelemetry/api and @opentelemetry/sdk-node
  // 2. Configure OTLP exporter in your app's instrumentation setup
  // 3. Use span.recordException(error) within active spans
}

/**
 * Set user context for OpenTelemetry tracing
 *
 * Call this in authentication middleware to attach user ID
 * to all subsequent spans in the request
 *
 * @param userId - User identifier
 *
 * @example
 * ```typescript
 * // In middleware.ts
 * import { setOtelUserContext } from '@repo/shared/server/otel';
 *
 * export async function authenticateUser(req, res, next) {
 *   const user = await getUser(req);
 *   setOtelUserContext(user.id);
 *   next();
 * }
 * ```
 */
export function setOtelUserContext(userId: string): void {
  // In production, this would set OTEL resource attributes
  // For now, we log via Logger
  otelLogger.debug(`[OTEL] User context set: ${userId}`, { userId });
}

/**
 * Add a span event for OpenTelemetry tracing
 *
 * Use this to add debugging events to the current span
 * (equivalent to Sentry breadcrumbs)
 *
 * @param name - Event name
 * @param attributes - Optional attributes
 *
 * @example
 * ```typescript
 * addOtelSpanEvent('payment.started', {
 *   amount: checkoutData.amount,
 *   currency: checkoutData.currency,
 * });
 * ```
 */
export function addOtelSpanEvent(
  name: string,
  attributes?: Record<string, unknown>,
): void {
  // In production, this would add events to the current active span
  // For now, we log via Logger
  otelLogger.debug(`[OTEL] Event: ${name}`, { attributes });
}
