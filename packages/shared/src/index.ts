// ============================================================================
// SHARED PACKAGE - MAIN EXPORTS (ISOMORPHIC ONLY)
//
// This barrel file exports ONLY environment-agnostic code:
//   - TypeScript types and interfaces
//   - Zod validation schemas
//   - Pure utility functions (no I/O, no Node.js APIs)
//   - Error classes and constants
//
// ⚠️  DO NOT import from '@repo/shared' in Edge runtime or client components
//     if you need server-only utilities. Use explicit import paths instead:
//   - Client components / Edge runtime: import { ... } from '@repo/shared/client'
//   - Server API routes / Server actions: import { ... } from '@repo/shared/server'
//   - Specific utilities: import { RedisClient } from '@repo/shared/redis'
//
// ============================================================================

// ============================================================================
// ERROR CLASSES & HANDLING (Isomorphic)
// ============================================================================
export * from "./errors";
export {
  ApiError,
  type ApiErrorOptions,
  type ApiErrorResponse,
  type ErrorCategory,
} from "./error-handler";

// ============================================================================
// LOGGER (Isomorphic structured logging)
// ============================================================================
export {
  Logger,
  getLogger,
  withRequestLogging,
  createTraceHeaders,
  tracedFetch,
  setTracingStorage,
  getTracingStorage,
  type LogContext,
  type LogLevel,
} from "./logger";

// ============================================================================
// SCHEMAS & VALIDATION (Isomorphic Zod schemas)
// ============================================================================
export * from "./api-schemas";
export * from "./api-response";
export {
  createValidationMiddleware,
  type ValidationMiddleware,
  type ValidationMiddlewareResult,
} from "./validation-middleware";

// ============================================================================
// SECURITY (Isomorphic headers & audit)
// ============================================================================
export * from "./security-middleware";
export * from "./security-audit";
export {
  generateSecurityHeaders,
  type SecurityHeadersConfig,
  type SecurityHeaderPreset,
  securityHeadersMiddleware,
  API_SECURITY_CONFIG,
} from "./security-headers";

// ============================================================================
// TRACING (Isomorphic subset)
// ============================================================================
export {
  CORRELATION_ID_HEADER,
  TRACE_ID_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  EXECUTION_ID_HEADER,
  ExecutionTraceEntrySchema,
  type ExecutionTraceEntry,
  type ExecutionTraceEntry as TraceEntry,
  InMemoryTraceEmitter,
  type TraceEmitter,
  withNervousSystemTracing,
  getCorrelationId,
  getTraceId,
  injectTracingHeaders,
  createTraceEntry,
  createStepCompletedEntry,
  createStepFailedEntry,
  createErrorEntry,
  tracingStorage,
  emitTrace,
  getGlobalTraceEmitter,
  setGlobalTraceEmitter,
} from "./tracing";

// ============================================================================
// RUNTIME REGISTRY (Isomorphic types)
// ============================================================================
export * from "./runtime-registry";

// ============================================================================
// TOOL TYPES (Isomorphic)
// ============================================================================
export * from "./types/tool";

// ============================================================================
// STATE MACHINE (Isomorphic)
// ============================================================================
export * from "./state-machine";

// ============================================================================
// NORMALIZATION (Isomorphic)
// ============================================================================
export * from "./normalization";

// ============================================================================
// CONFIGURATION SCHEMAS (Isomorphic Zod schemas)
// ============================================================================
export {
  BaseConfigSchema,
  ServiceUrlsSchema,
  FullConfigSchema,
  AppConfig,
} from "./config";
export type { FullConfig } from "./config";

// ============================================================================
// TYPE DEFINITIONS (Isomorphic)
// ============================================================================
export * from "./types/execution";
export type { DatabaseSchema } from "./types/database";

// ============================================================================
// CIRCUIT BREAKER (Isomorphic types & error classes)
// ============================================================================
export {
  CircuitBreaker,
  CircuitBreakerOpenError,
  type CircuitBreakerConfig,
  type CircuitBreakerStats,
  type CircuitEvent,
} from "./services/circuit-breaker";
export type { CircuitState } from "./services/circuit-breaker";

// ============================================================================
// OCC WITH REBASE (Optimistic Concurrency Control)
// ============================================================================
export {
  AtomicStateRebaser,
  createAtomicStateRebaser,
  atomicUpdateState,
  createWorkflowStateRebaser,
  buildExecutionStateKey,
} from "./services/occ-rebase";
export type {
  AtomicUpdateResult,
  AtomicUpdateOptions,
} from "./services/occ-rebase";

// ============================================================================
// REDIS (Client & utilities)
// ============================================================================
export {
  getRedisClient,
  getRedisConfig,
  ServiceNamespace,
  getNamespacePrefix,
} from "./redis";
export { getMemoryClient, MemoryClient } from "./redis/memory";

// ============================================================================
// PRIVACY & PII SCRUBBING (Isomorphic)
// ============================================================================
export * from "./services/privacy-gateway";

// ============================================================================
// MIDDLEWARE (Server-side utilities - use with care in client contexts)
// ============================================================================
export {
  withCache,
  withCacheMiddleware,
  type CacheConfig,
} from "./middleware/cache-middleware";
// ⚠️  withRedlock is DEPRECATED - use withDistributedLock instead
export { withRedlock } from "./services/redlock";
// New unified locking strategy (replaces Redlock)
export {
  withDistributedLock,
  acquireDistributedLock,
  releaseDistributedLock,
  getLockInfo,
  withDistributedLockLegacyCompat,
  type DistributedLockOptions,
  type LockResult,
  type LockInfo,
} from "./services/distributed-lock";
export {
  isReplayAllowed,
  rollbackReplayGuard,
} from "./middleware/web3-replay-guard";

// ============================================================================
// WEB3 / CRYPTO - ISOMORPHIC SCHEMAS ONLY
// ============================================================================
export * from "./utils/erc20-abi";
export * from "./utils/escrow-abi";
export * from "./utils/next-errors"; // Next.js redirect/notFound error detection

// ============================================================================
// REALTIME (Ably pub/sub)
// ============================================================================
export { RealtimeService } from "./realtime";

// JSON parsing utilities (isomorphic)
export {
  parseJsonWithFallback,
  safeParseJson,
  safeParseJsonSync,
  sanitizeJsonOutput,
} from "./utils/json-parser";

// Error handling utilities (AI-01: Global error sanitization)
export {
  withApiErrorHandler,
  formatError,
  formatSuccess,
  withRetry,
  withTimeout,
  settleAll,
  installGlobalErrorHandler, // SEC-01: Global error handler
  sanitizeErrorForExternal, // SEC-01: Error sanitization
} from "./error-handler";

// Idempotency Service (isomorphic interface)
export { IdempotencyService } from "./idempotency";

// API Error Utilities (isomorphic)
export {
  withServerActionHandler,
  type ServerActionResponse,
  formatApiError,
  formatApiSuccess,
  type ApiErrorResponse,
  type ApiSuccessResponse,
  createApiError,
  validateErrorResponse,
  getErrorStatusCode,
} from "./utils/api-error";

// ============================================================================
// SERVICES (Server-side utilities)
// ============================================================================
export { SERVICES } from "./services";
export { OutboxRelayService } from "./outbox-relay";
export { getOutboxListener } from "./services/outbox-listener";
export { getOutboxService } from "./outbox";
export { createSchemaEvolutionService } from "./services/schema-evolution";
export { createDLQMonitoringService } from "./services/dlq-monitoring";
export { createHeartbeatService } from "./services/heartbeat";
export { QStashService } from "./services/qstash";
export { NormalizationService } from "./normalization";
export {
  FailoverPolicyEngine,
  createFailoverPolicyEngine,
} from "./policies/failover-policy";
export {
  getLLMFailureTriageService,
  createLLMFailureTriageService,
} from "./services/llm-failure-triage";
export { createRepairAgent } from "./services/repair-agent";

// ============================================================================
// MIDDLEWARE (Additional server-side utilities)
// ============================================================================
export { withCronAuth } from "./middleware/cron-auth";
export { withQStashAuth } from "./services/qstash-webhook";

// ============================================================================
// OBSERVABILITY
// ============================================================================
export { registerObservabilityFlush } from "./error-handler";

// ============================================================================
// EVENT TYPES
// ============================================================================
export * from "./types/events";

// ============================================================================
// CLIENTS
// ============================================================================
export { getResendClient, getAblyClient } from "./clients";

// ============================================================================
// LLM CACHE
// ============================================================================
export { DEFAULT_TTL_SECONDS } from "./llm-cache";
