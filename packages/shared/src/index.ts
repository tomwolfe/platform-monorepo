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
export { Logger, type LogContext, type LogLevel } from "./logger";

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

// ============================================================================
// WEB3 / CRYPTO - ISOMORPHIC SCHEMAS ONLY
// ============================================================================
export * from "./utils/erc20-abi";
export * from "./utils/escrow-abi";
export * from "./utils/next-errors"; // Next.js redirect/notFound error detection

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
