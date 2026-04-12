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
// CRITICAL DIRECT RE-EXPORTS (prevent webpack tree-shaking bugs)
// These are re-exported directly in server.ts to avoid broken references
// caused by 3-level star re-export chains (index → server → index.shared → logger)
// ============================================================================
export {
  Logger,
  getLogger,
  getGlobalLogger,
  setGlobalLogger,
  withRequestLogging,
  createTraceHeaders,
  tracedFetch,
  setTracingStorage,
  getTracingStorage,
  secureConsole,
  scrubPII,
  type LogContext,
  type LogLevel,
} from "./logger";

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
// OutboxRelayService for fire-and-forget QStash triggers
export { OutboxRelayService } from "./outbox-relay";
// NOTE: getOutboxRelayService does not exist in outbox-relay

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
export {
  DEFAULT_TTL_SECONDS,
  getCachedResponse as getCachedLLMResponse,
  cacheResponse as cacheLLMResponse,
  getLLMCacheClient,
  invalidateLLMCache,
  type LLMCacheEntry,
} from "./llm-cache";
// NOTE: getLLMCache, setLLMCache do not exist in llm-cache
// NOTE: generateCacheKey from llm-cache conflicts with cache-middleware.generateCacheKey

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
export { bootstrapEnv, validateEnvSubset } from "./bootstrap";
export { SERVICES } from "./services";

// ============================================================================
// OBSERVABILITY FLUSH (Sentry/OpenTelemetry)
// ============================================================================
export { registerObservabilityFlush } from "./error-handler";
// NOTE: flushObservability does not exist in error-handler

// ============================================================================
// AUTH GATEWAY (Clerk server-side)
// ============================================================================
export { validateRequest } from "./auth/gateway";
// NOTE: getCurrentUser does not exist in auth/gateway

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
export * from "./server/sentry";

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

// ============================================================================
// OPENAPI SPECIFICATION
// ============================================================================
export {
  openApiSpecification,
  type OpenApiSpecification,
} from "./openapi-spec";

// ============================================================================
// API MIDDLEWARE & ERROR UTILITIES
// ============================================================================
export { withUnifiedApiHandler } from "./middleware/api-error-wrapper";
export { createErrorResponse } from "./utils/api-error";

// ============================================================================
// WEB3 UTILITIES (Nonce sync, wallet provider, verification)
// ============================================================================
export {
  getPublicClient,
  getEscrowResolverAddress,
} from "./utils/wallet-provider";
export {
  syncNonceFromChain,
  checkNonceSyncStatus,
} from "./utils/nonce-tracker";
export { isValidTxHash, verifyTransaction } from "./utils/web3-verification";
