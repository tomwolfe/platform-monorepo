/**
 * Next.js Instrumentation File
 *
 * This file is the proper entry point for initializing observability
 * in Next.js 15+. It ensures telemetry boots before the server
 * handles any requests, avoiding race conditions with side-effect
 * imports.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Initialize OpenTelemetry tracing
    const { initObservability } =
      await import("../intention-engine/src/lib/observability");
    initObservability("open-delivery");

    // Initialize Sentry error tracking (if DSN is configured)
    if (process.env.SENTRY_DSN) {
      const { initSentry } = await import("@repo/shared/server");
      await initSentry(process.env.SENTRY_DSN, {
        environment: process.env.NODE_ENV,
        release: process.env.SENTRY_RELEASE,
      });
    }
  }
}
