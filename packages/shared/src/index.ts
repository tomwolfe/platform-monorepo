// ============================================================================
// SHARED PACKAGE EXPORTS
// Phase 1-5 Roadmap Implementation
// ============================================================================

// Phase 1: Golden Path (System Spine)
export * from './golden-path';
// Note: tracing exports ExecutionTraceEntry (type), ExecutionTraceEntrySchema (schema)
export {
  CORRELATION_ID_HEADER,
  TRACE_ID_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  EXECUTION_ID_HEADER,
  ExecutionTraceEntrySchema,
  type ExecutionTraceEntry,
  type ExecutionTraceEntry as TraceEntry,
  InMemoryTraceEmitter,
  RedisTraceEmitter,
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
} from './tracing';

// Phase 2: Architecture Simplification
export * from './runtime-registry'; // Unified registry (tools, MCP, services)
export * from './infrastructure/cache'; // Standardized Redis cache layer

// Tool types
export * from './types/tool';

// Phase 5: Feature Flags (Gate autonomous features)
export * from './feature-flags';

// Legacy exports (below) - existing functionality
export * from './redis';
export * from './redis/memory';
export * from './types/execution';
export * from './normalization';
export * from './clients';
export * from './idempotency';
export * from './outbox';
export * from './services';
export * from './realtime';
export * from './realtime/ably-auth';
export * from './config';
export * from './state-machine';
export * from './policies/failover-policy';
export * from './services/semantic-memory';
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

// Phase 2: Security & Hardening
// DEPRECATED: tool-sandbox, wasm-sandbox, and chaos-engine are now exported from '@repo/shared/server'
// These modules use Node.js worker_threads and are NOT compatible with Edge runtime
export * from './services/migration-generator';
export * from './services/mcp-security-scanner';
export * from './services/circuit-breaker';

// Phase 3: Advanced Autonomy
export * from './services/anomaly-detector';
export * from './services/security-correlator';
export * from './services/dlq-monitoring';
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
export * from './services/privacy-gateway';
export * from './services/dry-run-simulator';
export * from './services/shadow-dry-run';

// Phase 4: Perfect Grade Enhancements (100/100)
// Causal ordering with sequence IDs
export * from './services/sequence-id';
export type { SequenceIdEvent, OrderedEventBufferConfig } from './services/sequence-id';

// OCC with automated rebase for ghost update prevention
export * from './services/occ-rebase';
export type { AtomicUpdateResult, AtomicUpdateOptions } from './services/occ-rebase';

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
export * from './utils/crypto'; // NEW: Timing-safe comparison and secure random generation
export * from './utils/api-error';
// Middleware exports (server-side only)
export * from './middleware/web3-replay-guard';
// export * from './utils/treasury'; // Treasury account management - import directly
// export * from './utils/crypto-price'; // Server-side only - import directly
// export * from './utils/web3-verification'; // Server-side only - import directly
