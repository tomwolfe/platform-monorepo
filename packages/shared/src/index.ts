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
export * from "./errors/http-codes";
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

// Trace Context Propagation
export {
  attachTraceToPayload,
  extractTraceFromPayload,
  extractTraceFromHeaders,
  withTraceContext,
  withTracePublish,
  withTraceAblyPublish,
  TRACE_META_KEY,
  TRACE_ID_META_KEY,
} from "./tracing/context-propagator";

// ============================================================================
// OPENTELEMETRY SPAN NAMING CONSTANTS
// ============================================================================
export { SpanPrefixes, SpanNames, SpanAttributes } from "./otel/constants";

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

// STRICT ENVIRONMENT VALIDATION
// ============================================================================
export {
  validateEnv,
  isEnvValid,
  getEnvVar,
  EnvValidationError,
  RequiredEnvSchema,
  ProductionOnlyEnvSchema,
  OptionalEnvSchema,
  Web3EnvSchema,
  SecurityEnvSchema,
  CommunicationEnvSchema,
  QStashEnvSchema,
  AIServicesEnvSchema,
  ObservabilityEnvSchema,
  FeatureFlagsEnvSchema,
  StripeEnvSchema,
  ServiceUrlsExtendedEnvSchema,
  ExtendedEnvSchema,
  BaseEnvSchema,
  FullEnvSchema,
} from "./config/env";
export type { BaseEnv, FullEnv, ExtendedEnv } from "./config/env";

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
  CircuitBreakerRegistry,
  createCircuitBreakerRegistry,
  defaultCircuitBreakerRegistry,
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
export {
  withCacheHeaders,
  applyCacheControl,
  buildCacheControlHeader,
  revalidateTag,
  PUBLIC_CACHE_CONFIG,
  PRIVATE_CACHE_CONFIG,
  NO_CACHE_CONFIG,
  type CacheConfig as CacheHeaderConfig,
} from "./middleware/cache-headers";
export {
  rateLimitMiddleware,
  createRateLimitMiddleware,
  extractUserIdentity,
  RateLimiterService,
  type EndpointRateLimitConfig,
  type RateLimitConfig,
  type RateLimitResult,
  type RateLimitMiddlewareResult,
} from "./middleware/rate-limiter";
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
  tryAcquireReplayProcessingLock,
  confirmReplayGuard,
  releaseReplayProcessingLock,
  getReplayGuard,
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

// Unified API Error Handler Wrapper
export {
  withUnifiedApiHandler,
  toUnifiedError,
  type UnifiedApiHandler,
  type UnifiedApiHandlerOptions,
} from "./middleware/api-error-wrapper";

// ============================================================================
// BOOTSTRAP (Startup validation gateway)
// ============================================================================
export { bootstrapEnv, validateEnvSubset } from "./bootstrap";

// ============================================================================
// HTTP RESPONSE FACTORY (Unified API response standardization)
// ============================================================================
export {
  // Response schemas
  ApiErrorResponseSchema,
  ApiSuccessResponseSchema,
  ApiErrorFieldSchema,

  // Response types
  type ApiErrorResponse,
  type ApiSuccessResponse,

  // Response factories
  successResponse,
  errorResponse,
  formatZodError,

  // Next.js response helpers
  jsonSuccess,
  jsonError,
} from "./http";

export {
  // Error classes
  ValidationError,
  // Auth errors
  UnauthorizedError,
  InvalidTokenError,
  TokenExpiredError,
  ForbiddenError,
  // Resource errors
  NotFoundError,
  ConflictError,
  AlreadyExistsError,
  // Service errors
  ServiceUnavailableError,
  RateLimitError,
  ExternalServiceError,
} from "./http";

export {
  // Handler wrapper
  withApiHandler,
  type ApiHandlerContext,
  type ApiHandler,
  type ApiHandlerConfig,
} from "./http";

// ============================================================================
// ROUTE HANDLER FACTORY
// ============================================================================
export {
  createRouteHandler,
  type RequestContext,
  type RouteHandlerFn,
  type RouteHandlerOptions,
  type RouteHandlerResponse,
} from "./utils/route-handler";

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
export { dispatchTask, type DispatchTask } from "./services/dispatch-queue";
export { NormalizationService } from "./normalization";
export {
  FailoverPolicyEngine,
  createFailoverPolicyEngine,
  type PolicyEvaluationContext,
  type FailoverPolicy,
  type PolicyEvaluationResult,
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
// AUTHENTICATION GATEWAY
// ============================================================================
export {
  validateRequest,
  type AuthGatewayContext,
  type AuthGatewayResult,
} from "./auth/gateway";

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

// ============================================================================
// LLM VALIDATION
// ============================================================================
export {
  validateLLMOutput,
  validateLLMOutputSync,
  parseJsonSafely,
  ValidationError,
  type LLMValidationOptions,
  type ValidationResult,
} from "./llm/validation";
