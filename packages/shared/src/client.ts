/**
 * Client-Safe Exports - Browser & Edge Runtime Compatible
 *
 * This module exports ONLY browser-safe code that can be imported
 * in React client components and Edge runtime without pulling in
 * Node.js-specific modules (redis, crypto, viem, etc.).
 *
 * Import from '@repo/shared/client' in:
 * - React client components ('use client')
 * - Edge runtime middleware
 * - Browser-side utilities
 *
 * DO NOT import from this module in:
 * - Server components (use '@repo/shared/server' instead)
 * - API routes (use '@repo/shared/server' instead)
 *
 * @package @repo/shared
 * @since 1.0.0
 */

// ============================================================================
// ERROR CLASSES & HANDLING (Browser-safe)
// ============================================================================
export * from "./errors";
export {
  ApiError,
  withApiErrorHandler,
  type ApiErrorOptions,
  type ApiErrorResponse,
  type ErrorCategory,
} from "./error-handler";

// ============================================================================
// LOGGER (Browser-safe structured logging)
// ============================================================================
export { Logger, type LogContext, type LogLevel } from "./logger";

// ============================================================================
// SCHEMAS & VALIDATION (Browser-safe Zod schemas)
// ============================================================================
export * from "./api-schemas";
export * from "./api-response";
export {
  createValidationMiddleware,
  type ValidationMiddleware,
  type ValidationMiddlewareResult,
} from "./validation-middleware";

// ============================================================================
// SECURITY (Browser-safe headers & audit)
// ============================================================================
export * from "./security-middleware";
export * from "./security-audit";
export {
  generateSecurityHeaders,
  type SecurityHeadersConfig,
  type SecurityHeaderPreset,
} from "./security-headers";

// ============================================================================
// TRACING TYPES & UTILITIES (Browser-safe subset)
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
  getCorrelationId,
  getTraceId,
  injectTracingHeaders,
  emitTrace,
  getGlobalTraceEmitter,
  setGlobalTraceEmitter,
} from "./tracing-types";

// ============================================================================
// RUNTIME REGISTRY (Browser-safe registry types)
// ============================================================================
export * from "./runtime-registry";

// ============================================================================
// TOOL TYPES (Browser-safe)
// ============================================================================
export * from "./types/tool";

// ============================================================================
// STATE MACHINE (Browser-safe)
// ============================================================================
export * from "./state-machine";

// ============================================================================
// NORMALIZATION (Browser-safe)
// ============================================================================
export * from "./normalization";

// ============================================================================
// CONFIGURATION SCHEMAS (Browser-safe Zod schemas only)
// ============================================================================
export {
  BaseConfigSchema,
  ServiceUrlsSchema,
  FullConfigSchema,
} from "./config";
export type { FullConfig } from "./config";

// ============================================================================
// BROWSER-SAFE CONFIG ACCESSORS (For Client Components)
// These safely access NEXT_PUBLIC_* environment variables in browser context
// ============================================================================
export const BrowserConfig = {
  /**
   * Get ESCROW contract address
   */
  getEscrowContractAddress(): string | null {
    return process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS || null;
  },

  /**
   * Get USDC contract address
   */
  getUsdcContractAddress(): string | null {
    return process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS || null;
  },

  /**
   * Get platform fee wallet address
   */
  getPlatformFeeWallet(): string | null {
    return process.env.NEXT_PUBLIC_PLATFORM_FEE_WALLET || null;
  },

  /**
   * Get Base RPC URL
   */
  getBaseRpcUrl(): string {
    return process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";
  },

  /**
   * Get Polygon RPC URL
   */
  getPolygonRpcUrl(): string {
    return process.env.NEXT_PUBLIC_POLYGON_RPC_URL || "https://polygon-rpc.com";
  },

  /**
   * Get Ethereum RPC URL
   */
  getEthRpcUrl(): string {
    return process.env.NEXT_PUBLIC_ETH_RPC_URL || "https://eth.llamarpc.com";
  },

  /**
   * Check if Web3 is configured (all required vars present)
   */
  isWeb3Configured(): boolean {
    return !!(
      process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS &&
      process.env.NEXT_PUBLIC_PLATFORM_FEE_WALLET
    );
  },
};

// ============================================================================
// TYPE DEFINITIONS (Browser-safe)
// ============================================================================
export * from "./types/execution";
export type { DatabaseSchema } from "./types/database";

// ============================================================================
// CIRCUIT BREAKER TYPES (Browser-safe types only)
// ============================================================================
export {
  CircuitBreakerOpenError,
  type CircuitBreakerConfig,
  type CircuitBreakerStats,
  type CircuitEvent,
} from "./services/circuit-breaker";
export type { CircuitState } from "./services/circuit-breaker";

// ============================================================================
// PRIVACY & PII SCRUBBING (Browser-safe)
// ============================================================================
export * from "./services/privacy-gateway";

// ============================================================================
// ACCESSIBILITY (React client components)
// ============================================================================
// Note: Import directly when needed - not exported here to avoid bundling
// import { AccessibilityProvider } from './accessibility';
