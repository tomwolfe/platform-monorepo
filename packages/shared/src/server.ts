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
// RE-EXPORT ISOMORPHIC MODULES (from cleaned index.ts)
// ============================================================================
export * from "./index";

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
} from "./services/sandbox/tool-sandbox";

export {
  WasmSandbox,
  createWasmSandbox,
  type WasmSandboxConfig,
  type WasmExecutionResult,
  type WasmSandboxStats,
} from "./services/sandbox/wasm-sandbox";

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
} from "./services/chaos/chaos-engine";

// ============================================================================
// SENTRY INTEGRATION - Node.js Only
// ============================================================================

/**
 * Sentry instance for error tracking
 * Only available in Node.js environments
 */
import { Logger } from "./logger";

const sentryLogger = new Logger({ serviceName: "sentry" });

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
  } = {},
) {
  try {
    const SentryModule = await import("@sentry/node");
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

    sentryLogger.info({ message: "Sentry initialized" });
  } catch (error) {
    sentryLogger.warn({
      message: "Failed to initialize Sentry",
      error: error instanceof Error ? error.message : String(error),
    });
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
export function addSentryBreadcrumb(
  message: string,
  data?: Record<string, unknown>,
) {
  if (Sentry) {
    Sentry.addBreadcrumb({ message, data, level: "info" });
  }
}

/**
 * Capture exception with Sentry
 */
export function captureSentryException(
  error: Error,
  context?: Record<string, unknown>,
) {
  if (Sentry) {
    Sentry.captureException(error, { extra: context });
  }
}

// ============================================================================
// SERVER-ONLY MODULES (Node.js APIs, Redis, External Services)
// ============================================================================

// Phase 1: Golden Path (System Spine)
export { openApiSpecification } from "./openapi-spec";

// Phase 2: Architecture Simplification
export * from "./infrastructure/cache"; // Standardized Redis cache layer

// Phase 2.2: Request Caching
export {
  withCache,
  generateCacheKey,
  invalidateCache,
  invalidateCacheByTag,
  invalidateCacheByPattern,
  getCacheMetrics,
  type CacheConfig,
  type CacheOptions,
  type CacheMiddlewareResult,
} from "./middleware/cache-middleware";

// Phase 2.3: Health Checks
export * from "./middleware/health-check";

// Phase 1.2: Cron Authentication
export {
  withCronAuth,
  verifyCronAuth,
  isCronAuthenticated,
  type CronAuthOptions,
  type CronAuthResult,
} from "./middleware/cron-auth";

// Legacy server-side exports
export * from "./redis";
export * from "./redis/memory";
export * from "./clients";
export * from "./idempotency";
export * from "./outbox";
export * from "./services";
export * from "./realtime";
export { AppConfig } from "./config";

// Phase 2: Security & Hardening
export * from "./services/migration-generator";
export * from "./services/mcp-security-scanner";

// Phase 3: Advanced Autonomy
export * from "./services/anomaly-detector";
export * from "./services/security-correlator";
export * from "./services/dlq-monitoring";
export * from "./services/monitoring";
export {
  getLLMFailureTriageService,
  createLLMFailureTriageService,
  LLMFailureTriageService,
  FailureReasonSchema,
  TriageResultSchema,
  type FailureReason,
  type TriageResult,
  type TriageContext,
  type FailureTriageService,
} from "./services/llm-failure-triage";
export * from "./services/dry-run-simulator";
export * from "./services/shadow-dry-run";

// Phase 4: Perfect Grade Enhancements
export * from "./services/sequence-id";
export type {
  SequenceIdEvent,
  OrderedEventBufferConfig,
} from "./services/sequence-id";

export * from "./services/occ-rebase";
export type {
  AtomicUpdateResult,
  AtomicUpdateOptions,
} from "./services/occ-rebase";

export * from "./policies/failover-policy";

export * from "./services/semantic-versioning";

export * from "./services/repair-agent";
export type {
  ZombieSaga,
  RepairAnalysis,
  FailureType,
  SuggestedFix,
  RepairResult,
} from "./services/repair-agent";

export * from "./services/contract-testing";
export type {
  ToolExecutionTrace,
  ToolContract,
  ContractTestResult,
} from "./services/contract-testing";

// Web3 / Crypto (server-side only)
export * from "./utils/crypto";
export {
  formatApiError,
  createApiError,
  formatApiSuccess,
  EngineErrorCodes,
  type EngineErrorCode,
  type FormatApiErrorOptions,
  isErrorResponse,
  isSuccessResponse,
  type ServerActionResponse,
  withServerActionHandler,
  ApiErrorResponseSchema,
  ApiSuccessResponseSchema,
  validateErrorResponse,
} from "./utils/api-error";
export * from "./middleware/web3-replay-guard";

// Phase 4.1: Provider Abstractions
export * from "./services/mobility-provider";
export * from "./services/communication-provider";

// Schema evolution
export {
  SchemaEvolutionService,
  getSchemaEvolutionService,
  createSchemaEvolutionService,
} from "./services/schema-evolution";
export type {
  AliasUsageRecord,
  MismatchEvent,
  SchemaEvolutionConfig,
} from "./services/schema-evolution";
export * from "./services/schema-versioning";
export * from "./services/heartbeat";
export * from "./services/parameter-aliaser";
export * from "./services/autonomous-schema-evolution";
export * from "./services/qstash";
export * from "./services/qstash-webhook";
export * from "./services/dispatch-queue";
export * from "./services/vector-store";
export * from "./services/pgvector-store";
export * from "./services/semantic-vector-store-pg";
export * from "./services/outbox-listener";
export * from "./services/state-diff-viewer";
export * from "./services/serverless-pubsub-bridge";
export * from "./outbox-relay";

// Circuit breaker (full server-side exports including classes)
export {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CostCircuitBreaker,
  createCircuitBreaker,
  createCircuitBreakerRegistry,
  createCostCircuitBreaker,
} from "./services/circuit-breaker";

// Webhook Dispatcher
export {
  WebhookDispatcherService,
  createWebhookDispatcherService,
  createWebhookHandler,
  withInternalWebhookAuth,
  type WebhookEvent,
  type WebhookHandler,
  type WebhookHandlerResult,
  type WebhookContext,
  type WebhookDispatcherConfig,
  type InternalWebhookContext,
  type InternalWebhookHandler,
} from "./services/webhook-dispatcher";

// Ably Authentication (uses @clerk/nextjs/server)
export * from "./realtime/ably-auth";
