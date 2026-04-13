// ============================================================================
// SHARED PACKAGE - MAIN EXPORTS (SERVER-ONLY BY DEFAULT)
//
// ⚠️  WARNING: This is the DEFAULT import path for @repo/shared.
//     It exports SERVER-ONLY modules (Redis, QStash, Ably, Drizzle).
//
//     Importing from '@repo/shared' in client components WILL bloat
//     your client bundle with server dependencies.
//
// ✅ CORRECT IMPORT PATHS:
//   - Client components / Edge runtime: import { ... } from '@repo/shared/client'
//   - Isomorphic utilities: import { ... } from '@repo/shared/shared'
//   - Server API routes / Server actions: import { ... } from '@repo/shared/server'
//
// ============================================================================

// Enforce server-only usage in Next.js client components
import "server-only";

// ============================================================================
// EXPLICIT RE-EXPORTS (avoids webpack tree-shaking bugs with export * chains)
// Next.js 15 has a known bug where multi-level star re-exports cause
// modules to be incorrectly tree-shaken, resulting in "X is not a constructor"
// errors during production builds.
// See: https://github.com/vercel/next.js/discussions/72497
// ============================================================================

// From index.shared (isomorphic)
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

export {
  formatError,
  formatSuccess,
  withRetry,
  withTimeout,
  settleAll,
  sanitizeErrorForExternal,
  ApiError,
  type ApiErrorOptions,
  type ApiErrorResponse,
  type ErrorCategory,
} from "./error-handler";

export {
  withUnifiedApiHandler,
  type UnifiedApiHandler,
  type UnifiedApiHandlerOptions,
} from "./middleware/api-error-wrapper";

export { createErrorResponse, formatApiError } from "./utils/api-error";
export { jsonSuccess, jsonError, type ApiResponse } from "./http";
export { deepEqual } from "./utils/deep-equal";
export { SERVICES } from "./services";
export { AppConfig } from "./config";
export { RealtimeService } from "./realtime";
export { getAblyClient } from "./clients";
export { IdempotencyService } from "./idempotency";

// Error classes
export * from "./errors";
export {
  CircuitBreakerOpenError,
  type CircuitBreakerConfig,
  type CircuitBreakerStats,
  type CircuitEvent,
  type CircuitState,
} from "./services/circuit-breaker";

// Tracing
export * from "./tracing";
export {
  attachTraceToPayload,
  extractTraceFromPayload,
  type TraceContext,
} from "./tracing/context-propagator";
export * from "./otel/constants";

// Security
export * from "./security-middleware";
export * from "./security-audit";
export {
  generateSecurityHeaders,
  type SecurityHeadersConfig,
  type SecurityHeaderPreset,
  securityHeadersMiddleware,
  API_SECURITY_CONFIG,
} from "./security-headers";

// Config & schemas
export {
  BaseConfigSchema,
  ServiceUrlsSchema,
  FullConfigSchema,
  CACHE_TIERS,
  getTTL,
  isValidTTL,
  describeTTL,
} from "./config";
export type { FullConfig, CacheTier, CacheTTLValue } from "./config";

// Types
export * from "./types/tool";
export {
  ExecutionStatusSchema,
  StepExecutionStateSchema,
  ExecutionStateSchema,
  TraceEntrySchema,
  ValidStateTransitions,
  isValidExecutionStatus,
  isValidStateTransition,
  isTerminalStatus,
  type ExecutionStatus,
  type StepExecutionState,
  type ExecutionState,
  type TraceEntry,
} from "./types/execution";
export type { DatabaseSchema } from "./types/database";
export * from "./types/events";

// Normalization & JSON
export * from "./normalization";
export {
  parseJsonWithFallback,
  safeParseJson,
  safeParseJsonSync,
  sanitizeJsonOutput,
  JsonParseError,
} from "./utils/json-parser";

// Validation
export {
  validatePayload,
  validatePayloadOptional,
  createValidator,
  parseAndValidateJson,
  PayloadValidationError,
} from "./utils/payload-validator";
export {
  validateLLMOutput,
  validateLLMOutputSync,
  createLlmRepairFn,
  LlmValidationError,
  type LLMValidationOptions,
  type ValidationResult,
} from "./llm/validation";

// Restaurant hours
export {
  isRestaurantOpenAtTime,
  isRestaurantOpenOnDay,
} from "./utils/restaurant-hours";

// ABIs & constants
export * from "./utils/erc20-abi";
export * from "./utils/escrow-abi";
export { isNextRedirectError } from "./utils/next-errors";

// Centralized constants
export * from "./constants";

// Async boundary errors
export {
  AsyncBoundaryError,
  AsyncBoundaryErrorCode,
  retryableError,
  permanentError,
  isAsyncBoundaryError,
  shouldRetry,
  type AsyncBoundaryErrorContext,
} from "./errors/async-boundary";

// State machine types
export type {
  StateMachineConfig,
  StateMachineContext,
  StateTransition,
} from "./state-machine";

// Privacy
export * from "./services/privacy-gateway";

// API schemas & validation
export * from "./api-schemas";
export * from "./api-response";
export {
  createValidationMiddleware,
  type ValidationMiddleware,
  type ValidationMiddlewareResult,
} from "./validation-middleware";

// Runtime registry
export * from "./runtime-registry";

// ============================================================================
// SERVER-ONLY EXPORTS (Node.js runtime only)
// ============================================================================

// Redis
export * from "./redis";
export * from "./redis/memory";

// Clients
export * from "./clients";

// Realtime (already exported Logger above)

// Outbox
export * from "./outbox";
export {
  getOutboxListener,
  notifyOutboxEvent,
  triggerOutboxRelay,
  type OutboxEvent,
  type OutboxListener,
} from "./services/outbox-listener";
export { OutboxRelayService } from "./outbox-relay";

// QStash
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

// Dispatch queue
export { dispatchTask } from "./services/dispatch-queue";

// Circuit breaker
export {
  CircuitBreaker,
  CircuitBreakerRegistry,
  createCircuitBreakerRegistry,
  defaultCircuitBreakerRegistry,
} from "./services/circuit-breaker";

// OCC rebase
export {
  AtomicStateRebaser,
  createAtomicStateRebaser,
  atomicUpdateState,
  createWorkflowStateRebaser,
} from "./services/occ-rebase";

// Cache middleware
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

// Rate limiter
export {
  rateLimitMiddleware,
  RateLimiterService,
  type RateLimiterConfig,
  type RateLimitResult,
} from "./middleware/rate-limiter";

// Distributed lock
export {
  withDistributedLock,
  acquireDistributedLock,
  releaseDistributedLock,
  getLockInfo,
  type DistributedLockConfig,
  type LockInfo,
} from "./services/distributed-lock";

// Web3 replay guard
export {
  isReplayAllowed,
  rollbackReplayGuard,
  tryAcquireReplayProcessingLock,
  confirmReplayGuard,
  releaseReplayProcessingLock,
  getReplayGuard,
} from "./middleware/web3-replay-guard";

// Schema evolution
export {
  createSchemaEvolutionService,
  type SchemaEvolutionConfig,
  type SchemaVersion,
} from "./services/schema-evolution";

// DLQ monitoring & heartbeat
export {
  createDLQMonitoringService,
  type DLQMonitoringConfig,
} from "./services/dlq-monitoring";
export {
  createHeartbeatService,
  type HeartbeatConfig,
} from "./services/heartbeat";

// LLM services
export {
  getLLMFailureTriageService,
  createLLMFailureTriageService,
} from "./services/llm-failure-triage";
export {
  createRepairAgent,
  type RepairAgentConfig,
} from "./services/repair-agent";

// LLM cache
export {
  DEFAULT_TTL_SECONDS,
  getCachedResponse as getCachedLLMResponse,
  cacheResponse as cacheLLMResponse,
  getLLMCacheClient,
  invalidateLLMCache,
  type LLMCacheEntry,
} from "./llm-cache";

// Cron auth
export {
  withCronAuth,
  verifyCronAuth,
  isCronAuthenticated,
  type CronAuthOptions,
  type CronAuthResult,
} from "./middleware/cron-auth";

// Bootstrap
export { bootstrapEnv, validateEnvSubset } from "./bootstrap";

// Observability flush
export { registerObservabilityFlush } from "./error-handler";

// Auth gateway
export { validateRequest } from "./auth/gateway";

// Sandboxes
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

// Chaos engineering
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

// Sentry
export * from "./server/sentry";

// Migration & security scanners
export * from "./services/migration-generator";
export * from "./services/mcp-security-scanner";

// Additional server-only services
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

// Autonomous schema evolution
export * from "./services/autonomous-schema-evolution";
export * from "./services/semantic-versioning";
export * from "./services/schema-versioning";

// Sequence id & ordering types
export type {
  SequenceIdEvent,
  OrderedEventBufferConfig,
} from "./services/sequence-id";

// OCC rebase types
export type {
  AtomicUpdateResult,
  AtomicUpdateOptions,
} from "./services/occ-rebase";

// Failover policy
export * from "./policies/failover-policy";

// Repair agent types
export type {
  ZombieSaga,
  RepairAnalysis,
  FailureType as RepairFailureType,
  SuggestedFix,
  RepairResult,
} from "./services/repair-agent";

// Contract testing types
export type {
  ToolExecutionTrace,
  ToolContract,
  ContractTestResult,
} from "./services/contract-testing";

// Web3 utils
export * from "./utils/crypto";
export {
  // NOTE: formatApiError is already exported above (line 64)
  createApiError,
  formatApiSuccess,
  EngineErrorCodes,
  type EngineErrorCode,
  isErrorResponse,
  isSuccessResponse,
  type ServerActionResponse,
  withServerActionHandler,
  ApiErrorResponseSchema,
  ApiSuccessResponseSchema,
  validateErrorResponse,
} from "./utils/api-error";
export {
  getPublicClient,
  getEscrowResolverAddress,
} from "./utils/wallet-provider";
export {
  syncNonceFromChain,
  checkNonceSyncStatus,
} from "./utils/nonce-tracker";
export { isValidTxHash, verifyTransaction } from "./utils/web3-verification";

// Schema evolution types
export type {
  AliasUsageRecord,
  MismatchEvent,
  SchemaEvolutionConfig as SchemaEvolutionConfigType,
} from "./services/schema-evolution";

// Webhook dispatcher
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

// Ably auth
export * from "./realtime/ably-auth";

// OpenAPI
export {
  openApiSpecification,
  type OpenApiSpecification,
} from "./openapi-spec";

// Additional response utilities
export {
  withValidatedResponse,
  type ValidatedResponseOptions,
  type ValidatedHandler,
} from "./utils/with-validated-response";
