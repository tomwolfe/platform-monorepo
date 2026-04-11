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
export * from "./errors";
export {
  ApiError,
  type ApiErrorOptions,
  type ApiErrorResponse,
  type ErrorCategory,
} from "./error-handler";

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
export * from "./tracing";
export * from "./tracing-types";

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
export * from "./types/execution";
export type { DatabaseSchema } from "./types/database";

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
export { serverActionResponse, handleServerAction } from "./outbox-relay";

export {
  withUnifiedApiHandler,
  type ApiHandler,
  type UnifiedApiContext,
} from "./error-handler";

export {
  createValidatedResponse,
  type ValidatedResponse,
} from "./utils/api-response";

export {
  withApiHandler,
  jsonSuccess,
  jsonError,
  type ApiResponse,
} from "./http";

// ============================================================================
// VALIDATED RESPONSE (Isomorphic)
// ============================================================================
export {
  createApiResponse,
  type ApiResponseOptions,
} from "./utils/next-errors";

// ============================================================================
// LLM VALIDATION (Isomorphic Zod schemas)
// ============================================================================
export {
  validateLLMInput,
  sanitizeLLMOutput,
  type LLMInputSchema,
  type LLMOutputSchema,
} from "./llm-cache";

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
export * from "./utils/next-errors";

// ============================================================================
// EVENT TYPES (Isomorphic)
// ============================================================================
export * from "./types/events";
