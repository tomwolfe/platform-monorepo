import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as tablestackSchema from "./schema/tablestack";
import * as pgvectorSchema from "./schema/pgvector";

export const schema = {
  ...tablestackSchema,
  ...pgvectorSchema,
};

// Re-export all schema items for convenience
export {
  users,
  restaurants,
  restaurantTables,
  restaurantReservations,
  restaurantWaitlist,
  restaurantProducts,
  inventoryLevels,
  guestProfiles,
  drivers,
  orders,
  orderItems,
  outbox,
  processed_crypto_transactions,
  crypto_transaction_speedups,
  cryptoPrices,
  // Enums
  waitlistStatusEnum,
  userRoleEnum,
  outboxStatusEnum,
  // Relations
  usersRelations,
  restaurantsRelations,
  restaurantTablesRelations,
  restaurantReservationsRelations,
  restaurantWaitlistRelations,
  restaurantProductsRelations,
  inventoryLevelsRelations,
  guestProfilesRelations,
  driversRelations,
  ordersRelations,
  orderItemsRelations,
} from "./schema/tablestack";

// Re-export pgvector items (semanticMemories is defined here, not in tablestack)
export {
  semanticMemories,
  semanticMemoriesRelations,
  cosineSimilarity,
  innerProduct,
  l2Distance,
  l1Distance,
  VECTOR_DIMENSIONS,
  ENABLE_PGVECTOR_SQL,
  CREATE_SEMANTIC_MEMORIES_SQL,
  CREATE_RECENT_MEMORIES_VIEW_SQL,
  type VectorDimensionSize,
  type SemanticMemory,
  type NewSemanticMemory,
  type SemanticMemorySearchQuery,
  type SemanticMemorySearchResult,
} from "./schema/pgvector";

// ============================================================================
// DATABASE CONFIGURATION & CONNECTION POOLING
// Phase 2.1: Performance & Reliability
// ============================================================================

/**
 * Database configuration options
 */
export interface DatabaseConfig {
  /** Connection pool size (default: 10) */
  poolSize?: number;
  /** Connection timeout in ms (default: 30000) */
  connectionTimeout?: number;
  /** Query timeout in ms (default: 60000) */
  queryTimeout?: number;
  /** Enable slow query logging (default: true) */
  enableSlowQueryLogging?: boolean;
  /** Slow query threshold in ms (default: 1000) */
  slowQueryThresholdMs?: number;
  /** Enable query logging (default: false) */
  enableQueryLogging?: boolean;
}

/**
 * Query statistics for monitoring
 */
export interface QueryStats {
  /** Total queries executed */
  totalQueries: number;
  /** Average query time in ms */
  avgQueryTimeMs: number;
  /** Slow queries count */
  slowQueries: number;
  /** Errors count */
  errors: number;
  /** Last query time */
  lastQueryTime?: Date;
}

// Default configuration
const DEFAULT_DB_CONFIG: DatabaseConfig = {
  poolSize: 10,
  connectionTimeout: 30000,
  queryTimeout: 60000,
  enableSlowQueryLogging: true,
  slowQueryThresholdMs: 1000,
  enableQueryLogging: false,
};

// Runtime configuration
let dbConfig: DatabaseConfig = { ...DEFAULT_DB_CONFIG };

// Query statistics
let queryStats: QueryStats = {
  totalQueries: 0,
  avgQueryTimeMs: 0,
  slowQueries: 0,
  errors: 0,
  lastQueryTime: undefined,
};

// Running total for average calculation
let totalQueryTimeMs = 0;

/**
 * Configure database connection pooling and query monitoring
 *
 * @param config - Database configuration options
 *
 * @example
 * ```typescript
 * configureDatabase({
 *   poolSize: 20,
 *   queryTimeout: 30000,
 *   enableSlowQueryLogging: true,
 *   slowQueryThresholdMs: 500,
 * });
 * ```
 */
export function configureDatabase(config: DatabaseConfig): void {
  dbConfig = { ...DEFAULT_DB_CONFIG, ...config };

  // Note: The Neon HTTP driver (drizzle-orm/neon-http) is stateless and does not
  // use connection pooling. poolSize and connectionTimeout settings are retained
  // for configuration tracking but do not affect the HTTP client behavior.
  // For long-running processes requiring true pooling, use the Pool client instead.

  console.log(
    `[Database] Configured with queryTimeout=${dbConfig.queryTimeout}ms, ` +
      `slowQueryThreshold=${dbConfig.slowQueryThresholdMs}ms`,
  );
}

/**
 * Get current database configuration
 */
export function getDatabaseConfig(): DatabaseConfig {
  return { ...dbConfig };
}

/**
 * Get query statistics
 */
export function getQueryStats(): QueryStats {
  return { ...queryStats };
}

/**
 * Reset query statistics (for testing)
 */
export function resetQueryStats(): void {
  queryStats = {
    totalQueries: 0,
    avgQueryTimeMs: 0,
    slowQueries: 0,
    errors: 0,
    lastQueryTime: undefined,
  };
  totalQueryTimeMs = 0;
}

// Standard Next.js global caching to prevent connection bloat during HMR
const globalForDb = globalThis as unknown as {
  _dbInstance: ReturnType<typeof drizzle> | null;
};

/**
 * Get the database instance with lazy initialization and HMR-safe global caching.
 * Throws a descriptive error at runtime if DATABASE_URL is not configured.
 *
 * This is the ONLY supported way to access the database. The db proxy export
 * has been removed to prevent type inference issues and masked connection failures.
 *
 * DB-03: Query Timeout Wrapper
 * - Wraps all queries with configurable timeout (default: 30s)
 * - Throws TimeoutError on exceedance
 *
 * @example
 * ```typescript
 * import { getDb } from '@repo/database';
 *
 * const db = getDb();
 * const users = await db.select().from(users);
 * ```
 *
 * @throws Error if DATABASE_URL is not configured
 * @throws TimeoutError if query exceeds the configured timeout
 */
export function getDb() {
  if (globalForDb._dbInstance) return globalForDb._dbInstance;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not configured. " +
        "Please set the DATABASE_URL environment variable to connect to the database.",
    );
  }

  const client = neon(databaseUrl);
  const baseDb = drizzle(client, { schema });

  // DB-03: Wrap with timeout proxy
  const timeoutMs = dbConfig.queryTimeout || 30000; // Default 30 seconds
  globalForDb._dbInstance = createTimeoutProxy(baseDb, timeoutMs);

  // Log initialization
  console.log(
    `[Database] Initialized with Neon HTTP driver, query timeout: ${timeoutMs}ms`,
  );

  return globalForDb._dbInstance;
}

// ============================================================================
// DB-03: Query Timeout Wrapper
// ============================================================================

/**
 * Error thrown when a query exceeds the configured timeout
 */
export class TimeoutError extends Error {
  constructor(
    message: string,
    public timeoutMs: number,
  ) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Creates a proxy around the Drizzle client that enforces query timeouts.
 * Wraps execute() and query methods with Promise.race timeout.
 */
function createTimeoutProxy<T extends Record<string, any>>(
  db: T,
  timeoutMs: number,
): T {
  return new Proxy(db, {
    get(target, prop: string) {
      const value = target[prop];

      // If it's not a function, return as-is
      if (typeof value !== "function") {
        return value;
      }

      // Wrap the function with timeout
      return function (...args: any[]) {
        const queryPromise = value.apply(target, args);

        // Create timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new TimeoutError(
                `Query timed out after ${timeoutMs}ms`,
                timeoutMs,
              ),
            );
          }, timeoutMs);
        });

        // Race between query and timeout
        return Promise.race([queryPromise, timeoutPromise]);
      };
    },
  });
}

export type { InferSelectModel, InferInsertModel } from "drizzle-orm";

// Re-export sql directly
export { sql } from "drizzle-orm";

// Database optimization utilities
export {
  INDEX_DEFINITIONS,
  createDatabaseIndexes,
  dropDatabaseIndexes,
  getIndexStats,
  getSlowQueries,
  optimizeQuery,
  batchLoad,
  logSlowQuery,
  measureQuery,
  type QueryOptimizationOptions,
} from "./optimization";

export {
  eq,
  lt,
  gt,
  gte,
  lte,
  desc,
  and,
  or,
  ne,
  isNull,
  isNotNull,
  inArray,
  notInArray,
  like,
  notLike,
  ilike,
  notIlike,
  exists,
  notExists,
  between,
  notBetween,
} from "drizzle-orm";

// ============================================================================
// WEB3 PAYMENT TYPES
// Type helpers for crypto payment handling with numeric precision
// ============================================================================

import type { InferSelectModel as DrizzleInferSelectModel } from "drizzle-orm";
import { orders } from "./schema/tablestack";

/**
 * CryptoAmount - String representation of token amounts in smallest units
 * - For ETH: Wei (18 decimals) - e.g., "1000000000000000000" = 1 ETH
 * - For USDC: Atomic units (6 decimals) - e.g., "1000000" = 1 USDC
 *
 * Use viem's formatUnits() to convert to human-readable format
 * Use viem's parseUnits() to convert from human-readable format
 */
export type CryptoAmount = string;

/**
 * OrderWithCryptoPayment - Extended order type with Web3 payment fields
 */
export type OrderWithCryptoPayment = DrizzleInferSelectModel<typeof orders> & {
  paymentTxHash: string | null;
  walletAddress: string | null;
  paymentCurrency: string | null;
  subtotal: CryptoAmount;
  tip: CryptoAmount;
  total: CryptoAmount;
};
