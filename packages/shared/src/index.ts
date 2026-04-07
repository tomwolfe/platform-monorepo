// ============================================================================
// SHARED PACKAGE - MAIN EXPORTS
// Phase 1-5 Roadmap Implementation
// ============================================================================
//
// ⚠️  WARNING: This barrel file re-exports BOTH client-safe and server-only
// modules. Importing from '@repo/shared' in a React client component or Edge
// runtime may inadvertently bundle Node.js-only code (redis, viem, crypto).
//
// RECOMMENDED IMPORT PATHS:
//   - Client components / Edge runtime: import { ... } from '@repo/shared/client'
//   - Server API routes / Server actions: import { ... } from '@repo/shared/server'
//   - Specific utilities: import { ... } from '@repo/shared/utils/crypto-price'
//
// ============================================================================

// Re-export all client-safe modules
export * from './client';

// ============================================================================
// SERVER-SIDE MODULES (Node.js only)
// ⚠️  These modules use Node.js APIs and will break Edge/Client runtime.
// For a complete server-side import, use '@repo/shared/server' instead.
// ============================================================================

// Phase 1: Golden Path (System Spine)
export { openApiSpecification } from './openapi-spec';

// Phase 2: Architecture Simplification
export * from './infrastructure/cache'; // Standardized Redis cache layer

// Phase 2.2: Request Caching (NEW - use this instead of deprecated cache-middleware)
// NOTE: Explicitly export to avoid conflicts with deprecated ./cache-middleware
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
} from './middleware/cache-middleware';

// Phase 2.3: Health Checks
export * from './middleware/health-check';

// Phase 1.2: Cron Authentication (NEW - deduplicated cron auth)
export {
  withCronAuth,
  verifyCronAuth,
  isCronAuthenticated,
  type CronAuthOptions,
  type CronAuthResult,
} from './middleware/cron-auth';

// Legacy server-side exports (below) - existing functionality
export * from './redis';
export * from './redis/memory';
export * from './clients';
export * from './idempotency';
export * from './outbox';
export * from './services';
// NOTE: realtime/ably-auth moved to @repo/shared/server to avoid Edge Runtime issues
// Import directly: import { createAblyAuthHandler } from '@repo/shared/realtime/ably-auth'
export * from './realtime';
export { AppConfig } from './config';

// Phase 2: Security & Hardening
// DEPRECATED: tool-sandbox, wasm-sandbox, and chaos-engine are now exported from '@repo/shared/server'
// These modules use Node.js worker_threads and are NOT compatible with Edge runtime
export * from './services/migration-generator';
export * from './services/mcp-security-scanner';

// Phase 3: Advanced Autonomy
export * from './services/anomaly-detector';
export * from './services/security-correlator';
export * from './services/dlq-monitoring';
export * from './services/monitoring'; // NEW: Monitoring & Alerting
// Note: llm-failure-triage exports are qualified to avoid FailureReason conflict
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
} from './services/llm-failure-triage';
export * from './services/dry-run-simulator';
export * from './services/shadow-dry-run';

// Phase 4: Perfect Grade Enhancements (100/100)
// Causal ordering with sequence IDs
export * from './services/sequence-id';
export type { SequenceIdEvent, OrderedEventBufferConfig } from './services/sequence-id';

// OCC with automated rebase for ghost update prevention
export * from './services/occ-rebase';
export type { AtomicUpdateResult, AtomicUpdateOptions } from './services/occ-rebase';

// Failover policy engine for resilient execution
export * from './policies/failover-policy';

// Semantic versioning enforcement with compatibility adapters
export * from './services/semantic-versioning';

// Automated repair agent for self-healing DLQ
export * from './services/repair-agent';
export type {
  ZombieSaga,
  RepairAnalysis,
  FailureType,
  SuggestedFix,
  RepairResult,
} from './services/repair-agent';

// Redlock algorithm for distributed locking
export * from './services/redlock';
export type {
  RedlockResource,
  RedlockConfig,
  RedlockLock,
  ReleaseResult,
  ExtendResult,
  AcquireResult,
} from './services/redlock';

// Consumer-driven contract testing for tools
export * from './services/contract-testing';
export type {
  ToolExecutionTrace,
  ToolContract,
  ContractTestResult,
} from './services/contract-testing';

// Web3 / Crypto Payment Utilities
// Note: ERC20_ABI is safe for client components
// Note: crypto-price utilities are server-side only (use direct import)
// Note: web3-verification is server-side only (use direct import)
// Note: treasury is server-side only (use direct import)
// Do NOT export these from main index - they require Node.js crypto
// Import directly: import { ... } from '@repo/shared/utils/treasury'
export * from './utils/erc20-abi';
export * from './utils/escrow-abi';
export * from './utils/crypto'; // NEW: Timing-safe comparison and secure random generation
export * from './utils/next-errors'; // Next.js redirect/notFound error detection
// Note: api-error exports some conflicting names (getErrorStatusCode, withApiErrorHandler)
// Export only non-conflicting items from utils/api-error
export {
  formatApiError,
  formatApiSuccess,
  createApiError,
  isErrorResponse,
  isSuccessResponse,
  withServerActionHandler,
  type ServerActionResponse,
  type ApiErrorResponse,
  type ApiSuccessResponse,
  type EngineErrorCodes,
  type EngineErrorCode,
  type FormatApiErrorOptions,
} from './utils/api-error';
// JSON parsing utilities
export { parseJsonWithFallback, safeParseJson, sanitizeJsonOutput } from './utils/json-parser';
// Middleware exports (server-side only)
export * from './middleware/web3-replay-guard';

// Phase 4.1: Provider Abstractions (Mobility & Communication)
export * from './services/mobility-provider';
export * from './services/communication-provider';

// Schema evolution - export from main file only (autonomous-schema-evolution re-exports)
export { SchemaEvolutionService, getSchemaEvolutionService, createSchemaEvolutionService } from './services/schema-evolution';
export type { AliasUsageRecord, MismatchEvent, SchemaEvolutionConfig } from './services/schema-evolution';
export * from './services/schema-versioning';
export * from './services/heartbeat';
export * from './services/parameter-aliaser';
export * from './services/autonomous-schema-evolution';
export * from './services/qstash';
export * from './services/qstash-webhook';
export * from './services/vector-store';
export * from './services/pgvector-store';
export * from './services/semantic-vector-store-pg';
export * from './services/outbox-listener';
export * from './services/state-diff-viewer';
export * from './services/serverless-pubsub-bridge';
export * from './outbox-relay';

// Note: circuit-breaker exports TimeoutError which conflicts with errors.ts
// Export explicitly excluding TimeoutError - only export non-conflicting items
export {
  CircuitBreaker,
  CircuitBreakerRegistry,
  CostCircuitBreaker,
  createCircuitBreaker,
  createCircuitBreakerRegistry,
  createCostCircuitBreaker,
} from './services/circuit-breaker';

// export * from './utils/treasury'; // Treasury account management - import directly
// export * from './utils/crypto-price'; // Server-side only - import directly
// export * from './utils/web3-verification'; // Server-side only - import directly

// Phase 4.1: Accessibility - React components, not exported for tests
// export * from './accessibility.tsx'; // React-specific, import directly if needed
