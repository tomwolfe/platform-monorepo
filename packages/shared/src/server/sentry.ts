/**
 * ⚠️ DEPRECATED: Sentry Error Tracking Shim
 *
 * This file is deprecated. Use OpenTelemetry (OTEL) for error tracking instead.
 *
 * Migration Guide:
 * - `captureSentryException(error)` → `captureErrorForOtel(error)` from './otel'
 * - `setSentryUser({ id, email })` → `setOtelUserContext(userId)` from './otel'
 * - `addSentryBreadcrumb(message)` → `addOtelSpanEvent(name)` from './otel'
 *
 * Why OTEL?
 * - Industry standard, vendor-neutral
 * - Natively supported by Vercel, Datadog, Honeycomb, etc.
 * - No build issues with Next.js/Turborepo
 * - Combines traces, metrics, and logs in one protocol
 *
 * @see ./otel.ts for the replacement implementation
 * @deprecated Use './otel' instead
 */

export {
  captureErrorForOtel as captureSentryException,
  setOtelUserContext as setSentryUser,
  addOtelSpanEvent as addSentryBreadcrumb,
} from "./otel";

// For backward compatibility, initSentry is a no-op
export async function initSentry(
  _dsn: string,
  _options: {
    environment?: string;
    release?: string;
    tracesSampleRate?: number;
  } = {},
) {
  // No-op: OTEL is configured via environment variables and instrumentation
}
