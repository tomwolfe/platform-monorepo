/**
 * Shared (Isomorphic) Exports - Node.js & Edge Runtime Compatible
 *
 * This module exports environment-agnostic code that works in both
 * Node.js and Edge runtimes, but may use Node.js builtins (async_hooks, crypto).
 *
 * NOT browser-safe: May use Node.js APIs unavailable in browsers.
 * Safe for: API routes, server actions, middleware, Edge functions.
 *
 * Import from '@repo/shared/shared' in:
 * - Next.js API routes (both Edge and Node runtimes)
 * - Server actions
 * - Isomorphic utilities
 *
 * DO NOT import from this module in:
 * - React client components (use '@repo/shared/client' instead)
 * - Browser-side code
 *
 * @package @repo/shared
 * @since 1.0.0
 */

// ============================================================================
// ERROR CLASSES (Full exports including async boundary errors)
// ============================================================================
// Converted from export * to named exports for Next.js 15 tree-shaking compatibility
export {
  ErrorCode,
  ERROR_STATUS_MAP,
  AppError,
  ValidationError,
  MissingFieldError,
  InvalidFormatError,
  UnauthorizedError,
  InvalidTokenError,
  TokenExpiredError,
  ForbiddenError,
  InsufficientPermissionsError,
  NotFoundError,
  ConflictError,
  AlreadyExistsError,
  ResourceUnavailableError,
  RateLimitedError,
  ExecutionFailedError,
  TimeoutError,
  ServiceUnavailableError,
  DatabaseError,
  ExternalServiceError,
  SagaCompensationFailedError,
  StateTransitionInvalidError,
  BusinessRuleViolationError,
  ClarificationRequiredError,
  type ErrorCode,
} from "./errors";
export {
  ApiError,
  type ApiErrorOptions,
  type ApiErrorResponse,
  type ErrorCategory,
} from "./error-handler";
// NOTE: flushObservability does not exist in error-handler
// (error-handler exports: registerObservabilityFlush, sanitizeErrorForExternal,
//  installGlobalErrorHandler, formatError, formatSuccess, withRetry, withTimeout, settleAll)

// ============================================================================
// LOGGER (Full structured logging)
// ============================================================================
export {
  Logger,
  getLogger,
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
// SCHEMAS & VALIDATION (Full Zod schemas + middleware)
// ============================================================================
export * from "./api-schemas";
export * from "./api-response";
export {
  createValidationMiddleware,
  type ValidationMiddleware,
  type ValidationMiddlewareResult,
} from "./validation-middleware";

// ============================================================================
// SECURITY (Full security utilities)
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
// TRACING (Full tracing with AsyncLocalStorage)
// ============================================================================
// Converted from export * to named exports for Next.js 15 tree-shaking compatibility
export {
  CORRELATION_ID_HEADER,
  TRACE_ID_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  EXECUTION_ID_HEADER,
  ExecutionTraceEntrySchema,
  ExecutionTraceSchema,
  tracingStorage,
  getCorrelationId,
  getTraceId,
  withNervousSystemTracing,
  injectTracingHeaders,
  TraceEmitter,
  InMemoryTraceEmitter,
  RedisTraceEmitter,
  createTraceEntry,
  createStepCompletedEntry,
  createStepFailedEntry,
  createErrorEntry,
  setGlobalTraceEmitter,
  getGlobalTraceEmitter,
  emitTrace,
  type ExecutionTraceEntry,
  type ExecutionTrace,
} from "./tracing";
// NOTE: Removed `export * from "./tracing-types"` to avoid star export conflicts
// with ./tracing for: CORRELATION_ID_HEADER, TRACE_ID_HEADER, IDEMPOTENCY_KEY_HEADER,
// EXECUTION_ID_HEADER, ExecutionTraceEntrySchema, ExecutionTraceSchema, emitTrace,
// getCorrelationId, getGlobalTraceEmitter, getTraceId, injectTracingHeaders,
// setGlobalTraceEmitter. The ./tracing module re-exports these from tracing-types already.

// Trace Context Propagation
export {
  attachTraceToPayload,
  extractTraceFromPayload,
  type TraceContext,
} from "./tracing/context-propagator";

// OpenTelemetry Constants
export * from "./otel/constants";

// ============================================================================
// RUNTIME REGISTRY & TYPES
// ============================================================================
export * from "./runtime-registry";
export * from "./types/tool";
// NOTE: Selective exports from ./types/execution to avoid ExecutionTraceSchema conflict with ./tracing
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

// Service registry (SERVICES is exported from ./services, not ./bootstrap)
export { SERVICES } from "./services";

// ============================================================================
// STATE MACHINE TYPES (Types only, NOT the Redis-backed class)
// ============================================================================
export type {
  StateMachineConfig,
  StateMachineContext,
  StateTransition,
} from "./state-machine";

// ============================================================================
// NORMALIZATION (Browser-safe)
// ============================================================================
export * from "./normalization";

// ============================================================================
// CONFIGURATION SCHEMAS (Zod schemas only, NO AppConfig that reads env)
// ============================================================================
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

// ============================================================================
// JSON PARSING (Isomorphic)
// ============================================================================
export {
  parseJsonWithFallback,
  safeParseJson,
  safeParseJsonSync,
  sanitizeJsonOutput,
} from "./utils/json-parser";

// ============================================================================
// DEEP EQUAL (lightweight, no JSON.stringify)
// ============================================================================
export { deepEqual } from "./utils/deep-equal";

// ============================================================================
// PAYLOAD VALIDATOR (Isomorphic async boundary validation)
// ============================================================================
export {
  validatePayload,
  validatePayloadOptional,
  createValidator,
  parseAndValidateJson,
  PayloadValidationError,
} from "./utils/payload-validator";

// ============================================================================
// RESTAURANT HOURS (Isomorphic)
// ============================================================================
export {
  isRestaurantOpenAtTime,
  isRestaurantOpenOnDay,
} from "./utils/restaurant-hours";

// ============================================================================
// ERROR HANDLING UTILITIES (Isomorphic)
// ============================================================================
export {
  formatError,
  formatSuccess,
  withRetry,
  withTimeout,
  settleAll,
  sanitizeErrorForExternal,
} from "./error-handler";

// ============================================================================
// API UTILITIES (Isomorphic server action/route handlers)
// ============================================================================
// NOTE: handleServerAction, serverActionResponse not exported from outbox-relay
// (only OutboxRelayService and publishToQStash are exported there)

export {
  withUnifiedApiHandler,
  type UnifiedApiHandler,
  type UnifiedApiHandlerOptions,
} from "./middleware/api-error-wrapper";

export {
  withValidatedResponse,
  type ValidatedResponseOptions,
  type ValidatedHandler,
} from "./utils/with-validated-response";

export { jsonSuccess, jsonError, type ApiResponse } from "./http";
export { createErrorResponse, formatApiError } from "./utils/api-error";

// ============================================================================
// VALIDATED RESPONSE (Isomorphic)
// ============================================================================
// NOTE: createApiResponse does not exist in utils/next-errors

// ============================================================================
// LLM VALIDATION (Isomorphic Zod schemas)
// ============================================================================
// NOTE: validateLLMInput, sanitizeLLMOutput do not exist in llm-cache
// (llm-cache exports: generateCacheKey, getCachedResponse, cacheResponse,
//  getLLMCacheClient, invalidateLLMCache, LLMCacheEntry, DEFAULT_TTL_SECONDS)

// ============================================================================
// LLM OUTPUT VALIDATION PIPELINE (Zod + JSON repair)
// ============================================================================
export {
  validateLLMOutput,
  validateLLMOutputSync,
  createLlmRepairFn,
  ValidationError,
  type LLMValidationOptions,
  type ValidationResult,
} from "./llm/validation";

// ============================================================================
// PRIVACY & PII SCRUBBING (Isomorphic)
// ============================================================================
export * from "./services/privacy-gateway";

// ============================================================================
// CIRCUIT BREAKER TYPES & ERRORS (NOT the Redis-backed class)
// ============================================================================
export {
  CircuitBreakerOpenError,
  type CircuitBreakerConfig,
  type CircuitBreakerStats,
  type CircuitEvent,
  type CircuitState,
} from "./services/circuit-breaker";

// ============================================================================
// WEB3 ABIs (Isomorphic constants)
// ============================================================================
export * from "./utils/erc20-abi";
export * from "./utils/escrow-abi";
// NOTE: utils/next-errors only exports isNextRedirectError (not createApiResponse)
export { isNextRedirectError } from "./utils/next-errors";

// ============================================================================
// ASYNC BOUNDARY ERRORS (for QStash, Ably, Webhooks)
// ============================================================================
export {
  AsyncBoundaryError,
  AsyncBoundaryErrorCode,
  retryableError,
  permanentError,
  isAsyncBoundaryError,
  shouldRetry,
  type AsyncBoundaryErrorContext,
} from "./errors/async-boundary";

// ============================================================================
// EVENT TYPES (Isomorphic)
// ============================================================================
export * from "./types/events";
