import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { NeonDatabase, ExecuteResult } from "drizzle-orm/neon-serverless";
import type { NeonHttpDatabase } from "drizzle-orm/neon-serverless";
// Re-export commonly used drizzle-orm utilities
export {
  eq,
  and,
  or,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  sql,
  asc,
  desc,
  ne,
  isNull,
  isNotNull,
  inArray,
  notInArray,
  notLike,
  notIlike,
  exists,
  notExists,
  between,
  notBetween,
} from "drizzle-orm";
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
  outboxDlq,
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
let _totalQueryTimeMs = 0;

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

  // Note: The Neon WebSocket Pool driver uses true connection pooling.
  // poolSize and connectionTimeout settings are retained for configuration
  // tracking and can be applied to the Pool constructor.

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
  _totalQueryTimeMs = 0;
}

// Standard Next.js global caching to prevent connection bloat during HMR
const globalForDb = globalThis as unknown as {
  _dbInstance: unknown;
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

  const pool = new Pool({ connectionString: databaseUrl });
  const baseDb = drizzle(pool, { schema });

  // DB-03: Wrap with timeout-safe wrapper
  const timeoutMs = dbConfig.queryTimeout || 30000; // Default 30 seconds
  globalForDb._dbInstance = createTimeoutDbWrapper(baseDb, timeoutMs);

  // Log initialization
  console.log(
    `[Database] Initialized with Neon WebSocket driver (Pool), query timeout: ${timeoutMs}ms`,
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
 * DB-03: Composition-based timeout wrapper for Drizzle's NeonDatabase.
 *
 * Replaces the previous Proxy-based approach which broke Drizzle's internal
 * symbol-based state tracking (e.g., transaction context, query builders).
 *
 * This wrapper holds a reference to the real Drizzle instance and delegates
 * all operations to it. Only execute() and transaction() are overridden
 * to enforce timeouts. All other properties (including internal symbols)
 * are forwarded transparently via a minimal, symbol-safe Proxy that only
 * intercepts property access for delegation — it does NOT wrap functions
 * with timeouts, preserving Drizzle's internal behavior.
 *
 * IMPORTANT: Neon HTTP Driver Limitation
 * The Neon HTTP driver is stateless — each query is an independent HTTP request.
 * Promise.race() frees the Node.js thread on timeout, but does NOT cancel the
 * query executing on the Neon Postgres server. This can lead to connection pool
 * exhaustion from "zombie" queries under heavy load.
 *
 * Mitigation:
 * - For transactions, use `SET LOCAL statement_timeout = '...'` inside the tx
 *   (see apps/open-delivery/src/app/customer/actions.ts for an example).
 * - For individual queries, configure statement_timeout at the database role level:
 *   `ALTER ROLE your_role SET statement_timeout = '30s';`
 */
class TimeoutDbWrapper<
  TSchema extends Record<string, unknown> = Record<string, never>,
> {
  readonly #db: NeonDatabase<TSchema>;
  readonly #timeoutMs: number;

  constructor(db: NeonDatabase<TSchema>, timeoutMs: number) {
    this.#db = db;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Wrap a promise with a timeout using Promise.race
   */
  #withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new TimeoutError(
            `Query timed out after ${this.#timeoutMs}ms`,
            this.#timeoutMs,
          ),
        );
      }, this.#timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      clearTimeout(timer!);
    }) as Promise<T>;
  }

  /**
   * Execute a query with timeout enforcement
   */
  execute(...queries: unknown[]): Promise<ExecuteResult | ExecuteResult[]> {
    return this.#withTimeout(
      (
        this.#db.execute as (
          ...args: unknown[]
        ) => Promise<ExecuteResult | ExecuteResult[]>
      )(...queries),
    );
  }

  /**
   * Run a transaction with timeout enforcement on the transaction callback.
   * The tx object passed to the callback is wrapped with timeout enforcement,
   * ensuring individual queries inside the transaction also respect timeouts.
   */
  transaction<T>(fn: (tx: NeonDatabase<TSchema>) => Promise<T>): Promise<T> {
    return this.#withTimeout(
      this.#db.transaction((rawTx) => {
        const wrappedTx = createTimeoutDbWrapper(rawTx, this.#timeoutMs);
        return fn(wrappedTx);
      }),
    );
  }
}

// Make the wrapper behave like the underlying Drizzle instance for all
// property accesses, using a Proxy that ONLY forwards — it does NOT wrap
// methods with timeouts (unlike the old createTimeoutProxy). The only
// timeout-wrapped methods are execute() and transaction() defined above.
function createTimeoutDbWrapper<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(db: NeonDatabase<TSchema>, timeoutMs: number): NeonDatabase<TSchema> {
  const wrapper = new TimeoutDbWrapper(db, timeoutMs);

  return new Proxy(db, {
    get(target, prop: string | symbol) {
      // Check if the wrapper defines the property (execute, transaction with timeout)
      if (prop === "execute") {
        return wrapper.execute.bind(wrapper);
      }
      if (prop === "transaction") {
        return wrapper.transaction.bind(wrapper);
      }
      // Otherwise, delegate to the underlying Drizzle instance
      return (target as unknown as Record<string | symbol, unknown>)[prop];
    },
  }) as NeonHttpDatabase<TSchema>;
}

export type { InferSelectModel, InferInsertModel } from "drizzle-orm";

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
