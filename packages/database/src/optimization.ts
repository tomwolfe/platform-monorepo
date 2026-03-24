/**
 * Database Optimization Utilities
 *
 * Provides database indexes, query optimization helpers, and performance monitoring.
 *
 * Usage:
 * ```typescript
 * import { createDatabaseIndexes, optimizeQuery, withQueryCache } from '@repo/database';
 *
 * // Create indexes on deployment
 * await createDatabaseIndexes(db);
 *
 * // Use optimized query
 * const reservations = await optimizeQuery(
 *   db.select().from(restaurantReservations),
 *   { indexHint: 'idx_reservations_restaurant_time' }
 * );
 * ```
 *
 * @see Phase 2.1: Database Optimization
 */

import { sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { getDb } from './index';

// ============================================================================
// DATABASE INDEXES
// ============================================================================

/**
 * Index definitions for performance optimization
 */
const INDEX_DEFINITIONS = {
  // Restaurant indexes
  restaurants: [
    {
      name: 'idx_restaurants_owner_email',
      columns: ['owner_email'],
      unique: false,
      description: 'Speed up restaurant lookup by owner email',
    },
    {
      name: 'idx_restaurants_wallet_address',
      columns: ['wallet_address'],
      unique: false,
      description: 'Speed up restaurant lookup by wallet address',
    },
    {
      name: 'idx_restaurants_is_shadow',
      columns: ['is_shadow', 'is_claimed'],
      unique: false,
      description: 'Speed up filtering shadow/claimed restaurants',
    },
  ],

  // Reservation indexes
  restaurantReservations: [
    {
      name: 'idx_reservations_restaurant_time',
      columns: ['restaurant_id', 'start_time', 'end_time'],
      unique: false,
      description: 'Speed up availability checks and conflict detection',
    },
    {
      name: 'idx_reservations_guest_email',
      columns: ['guest_email'],
      unique: false,
      description: 'Speed up guest profile lookup',
    },
    {
      name: 'idx_reservations_status_time',
      columns: ['status', 'start_time'],
      unique: false,
      description: 'Speed up upcoming reservations query',
    },
    {
      name: 'idx_reservations_table_time',
      columns: ['table_id', 'start_time', 'end_time'],
      unique: false,
      description: 'Speed up table availability checks',
    },
    {
      name: 'idx_reservations_verification_token',
      columns: ['verification_token'],
      unique: true,
      description: 'Speed up reservation verification',
    },
    {
      name: 'idx_reservations_payment_tx',
      columns: ['payment_tx_hash'],
      unique: true,
      description: 'Speed up payment verification',
    },
  ],

  // Table indexes
  restaurantTables: [
    {
      name: 'idx_tables_restaurant_status',
      columns: ['restaurant_id', 'status', 'is_active'],
      unique: false,
      description: 'Speed up available table lookup',
    },
    {
      name: 'idx_tables_capacity',
      columns: ['restaurant_id', 'min_capacity', 'max_capacity'],
      unique: false,
      description: 'Speed up table search by party size',
    },
  ],

  // Guest profile indexes
  guestProfiles: [
    {
      name: 'idx_guest_profiles_restaurant_email',
      columns: ['restaurant_id', 'email'],
      unique: false,
      description: 'Speed up guest profile lookup',
    },
    {
      name: 'idx_guest_profiles_visit_count',
      columns: ['restaurant_id', 'visit_count'],
      unique: false,
      description: 'Speed up high-value guest identification',
    },
  ],

  // Waitlist indexes
  restaurantWaitlist: [
    {
      name: 'idx_waitlist_restaurant_status',
      columns: ['restaurant_id', 'status', 'created_at'],
      unique: false,
      description: 'Speed up waitlist queries',
    },
  ],

  // Orders indexes
  orders: [
    {
      name: 'idx_orders_restaurant_status',
      columns: ['restaurant_id', 'status'],
      unique: false,
      description: 'Speed up order lookup',
    },
    {
      name: 'idx_orders_customer',
      columns: ['customer_id'],
      unique: false,
      description: 'Speed up customer order history',
    },
    {
      name: 'idx_orders_payment_tx',
      columns: ['payment_tx_hash'],
      unique: true,
      description: 'Speed up payment verification',
    },
    {
      name: 'idx_orders_created',
      columns: ['created_at'],
      unique: false,
      description: 'Speed up recent orders query',
    },
  ],

  // Processed crypto transactions (replay prevention)
  processed_crypto_transactions: [
    {
      name: 'idx_processed_tx_hash',
      columns: ['tx_hash'],
      unique: true,
      description: 'Speed up replay prevention checks',
    },
    {
      name: 'idx_processed_entity',
      columns: ['app_source', 'entity_id'],
      unique: false,
      description: 'Speed up entity transaction lookup',
    },
  ],
};

/**
 * Create all database indexes
 *
 * @param db - Database instance
 * @returns Array of created index names
 */
async function createDatabaseIndexes(
  db?: ReturnType<typeof getDb>
): Promise<string[]> {
  const database = db || getDb();
  const createdIndexes: string[] = [];

  // Execute index creation SQL
  const indexStatements: string[] = [];

  // Generate CREATE INDEX statements
  for (const [tableName, indexes] of Object.entries(INDEX_DEFINITIONS)) {
    for (const indexDef of indexes as any[]) {
      const unique = indexDef.unique ? 'UNIQUE ' : '';
      const columns = indexDef.columns.join(', ');
      const statement = `CREATE ${unique}INDEX IF NOT EXISTS ${indexDef.name} ON ${tableName} (${columns})`;
      indexStatements.push(statement);
    }
  }

  // Execute all index statements
  for (const statement of indexStatements) {
    try {
      await database.execute(sql.raw(statement));
      const indexName = statement.match(/INDEX IF NOT EXISTS (\w+)/)?.[1];
      if (indexName) {
        createdIndexes.push(indexName);
        console.log(`[Database] Created index: ${indexName}`);
      }
    } catch (error) {
      console.error(`[Database] Failed to create index: ${statement}`, error);
    }
  }

  return createdIndexes;
}

/**
 * Drop all custom indexes (for testing/migration)
 */
async function dropDatabaseIndexes(
  db?: ReturnType<typeof getDb>
): Promise<string[]> {
  const database = db || getDb();
  const droppedIndexes: string[] = [];

  for (const indexes of Object.values(INDEX_DEFINITIONS)) {
    for (const indexDef of indexes as any[]) {
      try {
        await database.execute(sql.raw(`DROP INDEX IF EXISTS ${indexDef.name}`));
        droppedIndexes.push(indexDef.name);
        console.log(`[Database] Dropped index: ${indexDef.name}`);
      } catch (error) {
        console.error(`[Database] Failed to drop index: ${indexDef.name}`, error);
      }
    }
  }

  return droppedIndexes;
}

/**
 * Get index usage statistics
 */
async function getIndexStats(
  db?: ReturnType<typeof getDb>
): Promise<Array<{
  indexName: string;
  tableName: string;
  sizeBytes: number;
  scans: number;
  rowsRead: number;
}>> {
  const database = db || getDb();

  const result = await database.execute(sql.raw(`
    SELECT
      indexrelname AS "indexName",
      relname AS "tableName",
      pg_size_pretty(pg_relation_size(indexrelid)) AS "size",
      pg_relation_size(indexrelid) AS "sizeBytes",
      idx_scan AS "scans",
      idx_tup_read AS "rowsRead"
    FROM pg_stat_user_indexes
    ORDER BY pg_relation_size(indexrelid) DESC
  `));

  return result.rows as any[];
}

/**
 * Get slow queries from pg_stat_statements
 */
async function getSlowQueries(
  db?: ReturnType<typeof getDb>,
  limit: number = 10
): Promise<Array<{
  query: string;
  calls: number;
  avgTimeMs: number;
  totalTimeMs: number;
}>> {
  const database = db || getDb();

  try {
    const result = await database.execute(sql.raw(`
      SELECT
        query,
        calls,
        ROUND(total_exec_time::numeric / calls::numeric, 2) AS "avgTimeMs",
        ROUND(total_exec_time::numeric, 2) AS "totalTimeMs"
      FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      ORDER BY total_exec_time DESC
      LIMIT ${limit}
    `));

    return result.rows as any[];
  } catch {
    console.warn('[Database] pg_stat_statements not available');
    return [];
  }
}

// ============================================================================
// QUERY OPTIMIZATION
// ============================================================================

/**
 * Query optimization options
 */
interface QueryOptimizationOptions {
  /** Use index hint */
  indexHint?: string;
  /** Limit results */
  limit?: number;
  /** Offset results */
  offset?: number;
  /** Order by */
  orderBy?: string;
  /** Use parallel query */
  parallel?: boolean;
  /** Cache results */
  cache?: boolean;
  /** Cache TTL in seconds */
  cacheTTL?: number;
}

/**
 * Optimize a query with hints and options
 *
 * Note: Drizzle ORM doesn't support query hints directly.
 * This function provides a wrapper for future optimization.
 */
function optimizeQuery<T extends Promise<any>>(
  query: T,
  options: QueryOptimizationOptions = {}
): T {
  // For now, just return the query as-is
  // Future: Add query hints, caching, etc.
  return query;
}

/**
 * Batch load related data to avoid N+1 queries
 *
 * @param items - Array of items to batch load
 * @param loader - Function to load related data
 * @param keySelector - Function to select key from item
 * @returns Map of items to related data
 *
 * @example
 * ```typescript
 * const reservations = await db.select().from(restaurantReservations);
 * const tablesMap = await batchLoad(
 *   reservations,
 *   async (tableIds) => {
 *     return db.select().from(restaurantTables).where(inArray(restaurantTables.id, tableIds));
 *   },
 *   (r) => r.tableId
 * );
 * ```
 */
async function batchLoad<T, K, R>(
  items: T[],
  loader: (keys: K[]) => Promise<R[]>,
  keySelector: (item: T) => K | null
): Promise<Map<K, R>> {
  // Collect unique keys
  const keys = new Set<K>();
  for (const item of items) {
    const key = keySelector(item);
    if (key !== null) {
      keys.add(key);
    }
  }

  // Load all related data in single query
  const results = await loader(Array.from(keys));

  // Create map for quick lookup
  const map = new Map<K, R>();
  for (const result of results) {
    // Assuming result has an id field
    const key = (result as any).id as K;
    map.set(key, result);
  }

  return map;
}

// ============================================================================
// QUERY MONITORING
// ============================================================================

/**
 * Query execution logger
 */
function logSlowQuery(
  query: string,
  durationMs: number,
  thresholdMs: number = 1000
): void {
  if (durationMs > thresholdMs) {
    console.warn(
      `[Slow Query] ${durationMs}ms (> ${thresholdMs}ms): ${query.substring(0, 200)}`
    );
  }
}

/**
 * Measure query execution time
 *
 * @param fn - Query function to measure
 * @param queryName - Name for logging
 * @returns Result of query function
 */
async function measureQuery<T>(
  fn: () => Promise<T>,
  queryName: string
): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  try {
    const result = await fn();
    const duration = Date.now() - start;
    logSlowQuery(queryName, duration);
    return { result, durationMs: duration };
  } catch (error) {
    const duration = Date.now() - start;
    console.error(`[Query Error] ${queryName} failed after ${duration}ms:`, error);
    throw error;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

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
};
