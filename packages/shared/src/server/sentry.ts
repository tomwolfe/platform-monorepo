/**
 * Sentry instance for error tracking
 * Only available in Node.js environments
 */
import { Logger } from "../logger";

const sentryLogger = new Logger({ serviceName: "sentry" });

/**
 * Initialize Sentry error tracking
 * Call this once at application startup in Node.js environments
 *
 * @param dsn - Sentry DSN
 * @param options - Sentry configuration
 */
export async function initSentry(
  dsn: string,
  options: {
    environment?: string;
    release?: string;
    tracesSampleRate?: number;
  } = {},
) {
  // Sentry integration disabled due to build issues in Next.js/Turborepo
  // To re-enable, we need to ensure this is only imported in server-only contexts
  // and handle Webpack's node: built-ins resolution for client bundles.
  sentryLogger.info(
    `Sentry initialization requested (DSN: ${dsn.substring(0, 10)}...) - INTEGRATION DISABLED`,
  );
}

/**
 * Configure Sentry user context for better error tracking
 */
export async function setSentryUser(user: {
  id?: string;
  email?: string;
  username?: string;
}) {
  // No-op - integration disabled
}

/**
 * Add Sentry breadcrumb for debugging
 */
export async function addSentryBreadcrumb(
  message: string,
  data?: Record<string, unknown>,
) {
  // No-op - integration disabled
}

/**
 * Capture exception with Sentry
 */
export async function captureSentryException(
  error: Error,
  context?: Record<string, unknown>,
) {
  // Fallback to console logging when Sentry is disabled
  sentryLogger.error(`Captured exception: ${error.message}`, {
    error: error.stack,
    ...context,
  });
}
