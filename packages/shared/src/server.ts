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
// SANDBOXES - Node.js Worker Threads & WASM
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
} from './services/sandbox/tool-sandbox';

export {
  WasmSandbox,
  createWasmSandbox,
  type WasmSandboxConfig,
  type WasmExecutionResult,
  type WasmSandboxStats,
} from './services/sandbox/wasm-sandbox';

// ============================================================================
// CHAOS ENGINEERING - Node.js Only
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
} from './services/chaos/chaos-engine';

// ============================================================================
// RE-EXPORT ALL OTHER SERVER-SIDE MODULES
// These are safe for Node.js but may not work in Edge/Client
// ============================================================================

// Re-export everything from main index for convenience
// Users can import server-only modules from this single entry point
export * from './index';
