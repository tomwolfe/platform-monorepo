/**
 * Server-Side Exports - Node.js Only
 *
 * This module exports all Node.js-specific functionality that is NOT compatible
 * with Next.js Edge runtime or client components.
 *
 * Import from '@repo/shared/server' in:
 * - Next.js API routes
 * - Server-side utilities
 * - Node.js scripts
 *
 * DO NOT import from this module in:
 * - Client components
 * - Edge runtime functions
 * - Middleware
 *
 * @package @repo/shared
 * @since 1.0.0
 */

// ============================================================================
// SANDBOXES - Node.js Worker Threads & WASM
// ============================================================================
export {
  ToolSandbox,
  createToolSandbox,
  writeWorkerScript,
  workerScript,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerError,
  type SandboxConfig,
  type SandboxStats,
} from './services/sandbox/tool-sandbox';

export {
  WasmSandbox,
  createWasmSandbox,
  type WasmSandboxConfig,
  type WasmExecutionResult,
  type WasmSandboxStats,
} from './services/sandbox/wasm-sandbox';

// ============================================================================
// CHAOS ENGINEERING - Node.js Only
// ============================================================================
export {
  ChaosEngine,
  createChaosEngine,
  type ChaosExperimentConfig,
  type FailureType,
  type FailureParameters,
  type SteadyStateHypothesis,
  type RollbackAction,
  type SafetyCheck,
} from './services/chaos/chaos-engine';

// ============================================================================
// SENTRY INTEGRATION - Node.js Only
// ============================================================================

/**
 * Sentry instance for error tracking
 * Only available in Node.js environments
 */
let Sentry: any = undefined;

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
  } = {}
) {
  try {
    const SentryModule = await import('@sentry/node');
    Sentry = SentryModule;

    Sentry.init({
      dsn,
      environment: options.environment || process.env.NODE_ENV,
      release: options.release,
      tracesSampleRate: options.tracesSampleRate || 0.1,
      integrations: [
        new Sentry.Integrations.Http({ tracing: true }),
        new Sentry.Integrations.Express({ app: undefined }),
      ],
    });

    console.log('[Sentry] Initialized');
  } catch (error) {
    console.warn('[Sentry] Failed to initialize:', error);
  }
}

/**
 * Configure Sentry user context for better error tracking
 */
export function setSentryUser(user: {
  id?: string;
  email?: string;
  username?: string;
}) {
  if (Sentry) {
    Sentry.setUser(user);
  }
}

/**
 * Add Sentry breadcrumb for debugging
 */
export function addSentryBreadcrumb(message: string, data?: Record<string, unknown>) {
  if (Sentry) {
    Sentry.addBreadcrumb({ message, data, level: 'info' });
  }
}

/**
 * Capture exception with Sentry
 */
export function captureSentryException(error: Error, context?: Record<string, unknown>) {
  if (Sentry) {
    Sentry.captureException(error, { extra: context });
  }
}

// ============================================================================
// RE-EXPORT ALL OTHER SERVER-SIDE MODULES
// These are safe for Node.js but may not work in Edge/Client
// ============================================================================

// Re-export everything from main index for convenience
// Users can import server-only modules from this single entry point
export * from './index';

// ============================================================================
// SERVER-ONLY MODULES
// These modules use server-only imports and are NOT compatible with client components
// ============================================================================

// Ably Authentication (uses @clerk/nextjs/server which imports server-only)
export * from './realtime/ably-auth';
