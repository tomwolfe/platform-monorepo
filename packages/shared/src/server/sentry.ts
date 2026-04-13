/**
 * Sentry Error Tracking Shim
 *
 * ⚠️  WARNING: Sentry integration is DISABLED
 *
 * This file provides a no-op shim to prevent build errors when code
 * imports Sentry functions. The actual Sentry SDK is not installed
 * due to build issues with Next.js/Turborepo.
 *
 * To re-enable Sentry:
 * 1. Install @sentry/nextjs package
 * 2. Configure Sentry in next.config.mjs
 * 3. Replace these shims with real Sentry calls
 * 4. Remove this warning
 *
 * Current behavior: All functions are no-ops (errors are NOT tracked)
 *
 * @deprecated Use proper error tracking solution (Sentry, LogRocket, etc.)
 */
import { Logger } from "../logger";

const sentryLogger = new Logger({ serviceName: "sentry-shim" });
let hasWarned = false;

function warnOnce(feature: string) {
  if (!hasWarned && process.env.NODE_ENV === "development") {
    sentryLogger.warn(
      `⚠️  ${feature} called but Sentry integration is DISABLED. ` +
        "Errors are NOT being tracked. See packages/shared/src/server/sentry.ts",
    );
    hasWarned = true; // Only warn once to avoid spam
  }
}

/**
 * Initialize Sentry error tracking
 *
 * ⚠️ NO-OP: Sentry is not currently integrated
 */
export async function initSentry(
  _dsn: string,
  _options: {
    environment?: string;
    release?: string;
    tracesSampleRate?: number;
  } = {},
) {
  warnOnce("initSentry");
  // Intentionally disabled - see file header
}

/**
 * Configure Sentry user context
 *
 * ⚠️ NO-OP: Sentry is not currently integrated
 */
export async function setSentryUser(_user: {
  id?: string;
  email?: string;
  username?: string;
}) {
  // No-op
}

/**
 * Add Sentry breadcrumb for debugging
 *
 * ⚠️ NO-OP: Sentry is not currently integrated
 */
export async function addSentryBreadcrumb(
  _message: string,
  _data?: Record<string, unknown>,
) {
  // No-op
}

/**
 * Capture exception with Sentry
 *
 * ⚠️ NO-OP: Sentry is not currently integrated
 * Errors are only logged to console, NOT sent to error tracking service
 */
export async function captureSentryException(
  error: Error,
  context?: Record<string, unknown>,
) {
  warnOnce("captureSentryException");
  // Log to Logger but don't send to Sentry (not configured)
  sentryLogger.error(`[Sentry Disabled] ${error.message}`, {
    error: error.stack,
    ...context,
  });
}
