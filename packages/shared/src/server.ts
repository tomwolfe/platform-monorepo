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
// RE-EXPORT SHARED & CLIENT-SAFE MODULES
// ============================================================================
export * from "./index.shared";

// ============================================================================
// APP CONFIG (Reads process.env at module scope)
// ============================================================================
export { AppConfig } from "./config";

// ============================================================================
// REDIS CLIENTS & MEMORY CACHE
// ============================================================================
export * from "./redis";
export * from "./redis/memory";

// ============================================================================
// EXTERNAL SERVICE CLIENTS (Ably, Resend)
// ============================================================================
export * from "./clients";

// ============================================================================
// REAL-TIME PUB/SUB (Ably)
// ============================================================================
export { RealtimeService } from "./realtime";

// ============================================================================
// IDEMPOTENCY SERVICE (Redis-backed)
// ============================================================================
export { IdempotencyService } from "./idempotency";

// ============================================================================
// OUTBOX PATTERN (Database + Redis)
// ============================================================================
export * from "./outbox";
export {
  getOutboxListener,
  notifyOutboxEvent,
  triggerOutboxRelay,
  type OutboxEvent,
  type OutboxListener,
} from "./services/outbox-listener";
export { OutboxRelayService, getOutboxRelayService } from "./outbox-relay";

// ============================================================================
// QSTASH SERVICE (Async workflow orchestration)
// ============================================================================
export {
  QStashService,
  type QStashConfig,
  type QStashTriggerOptions,
  type QStashMultiTriggerOptions,
  type QStashScheduleOptions,
} from "./services/qstash";
export {
  withQStashAuth,
  withQStashAuthEnhanced,
  verifyQStashWebhook,
  verifyQStashWebhookMiddleware,
} from "./services/qstash-webhook";

// ============================================================================
// DISPATCH QUEUE (QStash-based background tasks)
// ============================================================================
export { dispatchTask } from "./services/dispatch-queue";

// ============================================================================
// CIRCUIT BREAKER (Full Redis-backed implementation)
// ============================================================================
export {
  CircuitBreaker,
  CircuitBreakerRegistry,
  createCircuitBreakerRegistry,
  defaultCircuitBreakerRegistry,
} from "./services/circuit-breaker";

// ============================================================================
// OCC REBASE (Optimistic Concurrency Control - Redis-backed)
// ============================================================================
export {
  AtomicStateRebaser,
  createAtomicStateRebaser,
  atomicUpdateState,
  createWorkflowStateRebaser,
} from "./services/occ-rebase";

// ============================================================================
// CACHE MIDDLEWARE (Redis-backed request caching)
// ============================================================================
export {
  withCache,
  withCacheMiddleware,
  generateCacheKey,
  invalidateCache,
  invalidateCacheByTag,
  invalidateCacheByPattern,
  getCacheMetrics,
  type CacheConfig,
  type CacheOptions,
  type CacheMiddlewareResult,
} from "./middleware/cache-middleware";

// ============================================================================
// RATE LIMITER (Redis-backed)
// ============================================================================
export {
  rateLimitMiddleware,
  RateLimiterService,
  type RateLimiterConfig,
  type RateLimitResult,
} from "./middleware/rate-limiter";

// ============================================================================
// DISTRIBUTED LOCK (Redis-backed)
// ============================================================================
export {
  withDistributedLock,
  acquireDistributedLock,
  releaseDistributedLock,
  getLockInfo,
  type DistributedLockConfig,
  type LockInfo,
} from "./services/distributed-lock";

// ============================================================================
// WEB3 REPLAY GUARD (Database + Redis)
// ============================================================================
export {
  isReplayAllowed,
  rollbackReplayGuard,
  tryAcquireReplayProcessingLock,
  confirmReplayGuard,
  releaseReplayProcessingLock,
  getReplayGuard,
} from "./middleware/web3-replay-guard";

// ============================================================================
// SCHEMA EVOLUTION (Redis-backed)
// ============================================================================
export {
  createSchemaEvolutionService,
  type SchemaEvolutionConfig,
  type SchemaVersion,
} from "./services/schema-evolution";

// ============================================================================
// DLQ MONITORING & HEARTBEAT (Redis + QStash + Ably)
// ============================================================================
export {
  createDLQMonitoringService,
  type DLQMonitoringConfig,
} from "./services/dlq-monitoring";
export {
  createHeartbeatService,
  type HeartbeatConfig,
} from "./services/heartbeat";

// ============================================================================
// LLM SERVICES (Redis-backed failure triage & repair)
// ============================================================================
export {
  getLLMFailureTriageService,
  createLLMFailureTriageService,
} from "./services/llm-failure-triage";
export {
  createRepairAgent,
  type RepairAgentConfig,
} from "./services/repair-agent";

// ============================================================================
// LLM CACHE (Redis + Node crypto)
// ============================================================================
export { DEFAULT_TTL_SECONDS, getLLMCache, setLLMCache } from "./llm-cache";

// ============================================================================
// CRON AUTH (Server-only cron job validation)
// ============================================================================
export {
  withCronAuth,
  verifyCronAuth,
  isCronAuthenticated,
  type CronAuthOptions,
  type CronAuthResult,
} from "./middleware/cron-auth";

// ============================================================================
// BOOTSTRAP (Env validation at module scope)
// ============================================================================
export { bootstrapEnv, validateEnvSubset, SERVICES } from "./bootstrap";

// ============================================================================
// OBSERVABILITY FLUSH (Sentry/OpenTelemetry)
// ============================================================================
export {
  registerObservabilityFlush,
  flushObservability,
} from "./error-handler";

// ============================================================================
// AUTH GATEWAY (Clerk server-side)
// ============================================================================
export { validateRequest, getCurrentUser } from "./auth/gateway";

// ============================================================================
// SANDBOXES (Node.js Worker Threads & WASM)
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
// CHAOS ENGINEERING (Node.js Only)
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
// SENTRY INTEGRATION (Node.js Only)
// ============================================================================

/**
 * Sentry instance for error tracking
 * Only available in Node.js environments
 */
import { Logger } from "./logger";
import type * as SentryTypes from "@sentry/node";

const sentryLogger = new Logger({ serviceName: "sentry" });

let Sentry: typeof SentryTypes | undefined = undefined;

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
// ROUTE HANDLER FACTORY (Server-only)
// ============================================================================
export {
  createRouteHandler,
  type RouteHandlerConfig,
  type RouteHandlerContext,
} from "./utils/route-handler";

// ============================================================================
// TESTING UTILITIES (Server-only - database, drizzle, ably, resend, viem)
// ============================================================================
export * from "./testing";

// ============================================================================
// MIGRATION & SECURITY SCANNERS
// ============================================================================
export * from "./services/migration-generator";
export * from "./services/mcp-security-scanner";

// ============================================================================
// ADDITIONAL SERVER-ONLY SERVICES
// ============================================================================
export * from "./services/monitoring";
export * from "./services/semantic-vector-store-pg";
export * from "./services/pgvector-store";
export * from "./services/vector-store";
export * from "./services/semantic-memory";
export * from "./services/communication-provider";
export * from "./services/mobility-provider";
export * from "./services/transaction-speedup";
export * from "./services/shadow-dry-run";
export * from "./services/contract-testing";
export * from "./services/dry-run-simulator";
export * from "./services/parameter-aliaser";
export * from "./services/state-diff-viewer";
export * from "./services/anomaly-detector";
export * from "./services/security-correlator";
export * from "./services/serverless-pubsub-bridge";
export * from "./services/sequence-id";
export * from "./services/lamport-timestamps";

// ============================================================================
// AUTONOMOUS SCHEMA EVOLUTION
// ============================================================================
export * from "./services/autonomous-schema-evolution";
export * from "./services/semantic-versioning";
export * from "./services/schema-versioning";

// ============================================================================
// SEQUENCE ID & ORDERING
// ============================================================================
export type {
  SequenceIdEvent,
  OrderedEventBufferConfig,
} from "./services/sequence-id";

// ============================================================================
// OCC REBASE TYPES
// ============================================================================
export type {
  AtomicUpdateResult,
  AtomicUpdateOptions,
} from "./services/occ-rebase";

// ============================================================================
// FAILOVER POLICY
// ============================================================================
export * from "./policies/failover-policy";

// ============================================================================
// REPAIR AGENT TYPES
// ============================================================================
export type {
  ZombieSaga,
  RepairAnalysis,
  FailureType as RepairFailureType,
  SuggestedFix,
  RepairResult,
} from "./services/repair-agent";

// ============================================================================
// CONTRACT TESTING TYPES
// ============================================================================
export type {
  ToolExecutionTrace,
  ToolContract,
  ContractTestResult,
} from "./services/contract-testing";

// ============================================================================
// WEB3 / CRYPTO (server-side only)
// ============================================================================
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

// ============================================================================
// SCHEMA EVOLUTION TYPES
// ============================================================================
export type {
  AliasUsageRecord,
  MismatchEvent,
  SchemaEvolutionConfig as SchemaEvolutionConfigType,
} from "./services/schema-evolution";

// ============================================================================
// WEBHOOK DISPATCHER (Full exports)
// ============================================================================
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

// ============================================================================
// ABLY AUTHENTICATION (uses @clerk/nextjs/server)
// ============================================================================
export * from "./realtime/ably-auth";
