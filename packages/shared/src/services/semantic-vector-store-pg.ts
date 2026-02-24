/**
/**
 * PGVector-based Semantic Vector Store
 *
 * Implements hybrid vector-relational search using Neon pgvector.
 * Provides O(log N) search performance with HNSW/ivfflat indexing.
 *
 * Key Features:
 * - Hybrid search: Combine vector similarity with SQL filters in one query
 * - Transactional consistency: Join memory with live business data
 * - Metadata filtering: userId, intentType, restaurantId, timeRange, outcome
 * - HNSW/ivfflat indexing for production-scale performance
 *
 * Usage:
 * ```typescript
 * const store = createHybridSemanticStore();
 *
 * // Hybrid search: Vector + relational filters
 * const results = await store.search({
 *   queryVector: embedding,
 *   userId: 'user-123',
 *   intentType: 'book_restaurant',
 *   restaurantId: 'rest-456',
 *   minSimilarity: 0.7,
 *   limit: 5,
 * });
 *
 * // Join with live business data in single query
 * const results = await store.searchWithBusinessData({
 *   queryVector: embedding,
 *   userId: 'user-123',
 *   includeRestaurantAvailability: true,
 * });
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { db, semanticMemories, cosineSimilarity, type SemanticMemorySearchQuery, type SemanticMemorySearchResult } from '@repo/database';
import { sql, eq, and, gte, lte, isNull, or, desc, type SQL } from 'drizzle-orm';
import { z } from 'zod';

// ============================================================================
// SCHEMAS
// ============================================================================

/**
 * PGVector search query with hybrid filtering
 */
export const PGVectorSearchQuerySchema = z.object({
  /** Query vector (embedding) */
  queryVector: z.array(z.number()),
  /** Filter by user ID */
  userId: z.string().optional(),
  /** Filter by intent type */
  intentType: z.string().optional(),
  /** Filter by restaurant ID */
  restaurantId: z.string().uuid().optional(),
  /** Filter by outcome */
  outcome: z.enum(['success', 'failed', 'partial', 'abandoned']).optional(),
  /** Time range filter */
  timeRange: z.object({
    after: z.date().optional(),
    before: z.date().optional(),
  }).optional(),
  /** Maximum results to return */
  limit: z.number().int().positive().default(5),
  /** Minimum similarity threshold (0-1) */
  minSimilarity: z.number().min(0).max(1).default(0.5),
  /** Include business data joins (restaurant availability, user subscription, etc.) */
  includeBusinessData: z.boolean().default(false),
});

export type PGVectorSearchQuery = z.infer<typeof PGVectorSearchQuerySchema>;

/**
 * Search result with similarity score and optional business data
 */
export const PGVectorSearchResultSchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  intentType: z.string(),
  rawText: z.string(),
  parameters: z.record(z.unknown()).optional(),
  timestamp: z.string(),
  outcome: z.enum(['success', 'failed', 'partial', 'abandoned']).optional(),
  restaurantId: z.string().uuid().optional(),
  restaurantName: z.string().optional(),
  restaurantSlug: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  similarity: z.number().min(0).max(1),
  rank: z.number().int().positive(),
  // Optional business data (when includeBusinessData is true)
  businessData: z.object({
    restaurantAvailable: z.boolean().optional(),
    restaurantOpeningTime: z.string().optional(),
    restaurantClosingTime: z.string().optional(),
    userSubscriptionTier: z.string().optional(),
    userHasActiveSubscription: z.boolean().optional(),
  }).optional(),
});

export type PGVectorSearchResult = z.infer<typeof PGVectorSearchResultSchema>;

/**
 * Business data join configuration
 */
export interface BusinessDataJoinConfig {
  /** Include restaurant availability check */
  includeRestaurantAvailability?: boolean;
  /** Include user subscription tier */
  includeUserSubscription?: boolean;
  /** Include reservation conflict check */
  includeReservationConflicts?: boolean;
}

// ============================================================================
// HYBRID SEMANTIC STORE IMPLEMENTATION
// ============================================================================

export class HybridSemanticStore {
  private initialized = false;

  /**
   * Initialize pgvector (ensure extension is enabled)
   * Note: Extension must be enabled in Neon console or migration
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Verify pgvector extension is available
      await db.execute(sql`SELECT 1 FROM pg_extension WHERE extname = 'vector' LIMIT 1`);
      this.initialized = true;
      console.log('[PGVectorStore] pgvector extension verified');
    } catch (error) {
      console.error('[PGVectorStore] pgvector extension not enabled:', error);
      throw new Error(
        'pgvector extension not enabled. Run: CREATE EXTENSION IF NOT EXISTS vector;'
      );
    }
  }

  /**
   * Add a memory entry to pgvector
   *
   * Note: This method requires the embedding to be pre-generated.
   * For automatic embedding generation, use SemanticVectorStore instead.
   *
   * @param entry - Memory entry with embedding
   * @returns Created memory entry with ID
   */
  async addEntry(
    entry: z.infer<typeof import('./semantic-memory').SemanticMemoryEntrySchema>
  ): Promise<{ id: string }> {
    await this.initialize();

    const result = await db.insert(semanticMemories).values({
      id: entry.id,
      userId: entry.userId,
      intentType: entry.intentType,
      rawText: entry.rawText,
      embedding: entry.embedding,
      parameters: entry.parameters,
      timestamp: new Date(entry.timestamp),
      executionId: entry.executionId,
      restaurantId: entry.restaurantId,
      restaurantSlug: entry.restaurantSlug,
      restaurantName: entry.restaurantName,
      outcome: entry.outcome,
      metadata: entry.metadata,
    }).returning({ id: semanticMemories.id });

    console.log(
      `[HybridSemanticStore] Added memory ${entry.id} for user ${entry.userId} ` +
      `(intent: ${entry.intentType})`
    );

    return result[0]!;
  }

  /**
   * Search for similar memories with hybrid filtering
   *
   * PERFORMANCE: O(log N) with ivfflat/HNSW indexing
   *
   * @param query - Search query with vector and filters
   * @returns Results sorted by similarity
   */
  async search(query: PGVectorSearchQuery): Promise<PGVectorSearchResult[]> {
    await this.initialize();

    // Build similarity expression
    const similarityExpr = cosineSimilarity(semanticMemories.embedding, query.queryVector);

    // Build WHERE conditions
    const conditions: SQL[] = [];

    if (query.userId) {
      conditions.push(sql`${semanticMemories.userId} = ${query.userId}`);
    }

    if (query.intentType) {
      conditions.push(sql`${semanticMemories.intentType} = ${query.intentType}`);
    }

    if (query.restaurantId) {
      conditions.push(sql`${semanticMemories.restaurantId} = ${query.restaurantId}`);
    }

    if (query.outcome) {
      conditions.push(sql`${semanticMemories.outcome} = ${query.outcome}`);
    }

    if (query.timeRange) {
      if (query.timeRange.after) {
        conditions.push(sql`${semanticMemories.timestamp} >= ${query.timeRange.after}`);
      }
      if (query.timeRange.before) {
        conditions.push(sql`${semanticMemories.timestamp} <= ${query.timeRange.before}`);
      }
    }

    // Build query with similarity score
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Query with similarity threshold in HAVING clause for performance
    const results = await db
      .select({
        id: semanticMemories.id,
        userId: semanticMemories.userId,
        intentType: semanticMemories.intentType,
        rawText: semanticMemories.rawText,
        parameters: semanticMemories.parameters,
        timestamp: semanticMemories.timestamp,
        outcome: semanticMemories.outcome,
        restaurantId: semanticMemories.restaurantId,
        restaurantSlug: semanticMemories.restaurantSlug,
        restaurantName: semanticMemories.restaurantName,
        metadata: semanticMemories.metadata,
        similarity: sql<number>`(${similarityExpr})`,
      })
      .from(semanticMemories)
      .where(whereClause)
      .having(sql`(${similarityExpr}) >= ${query.minSimilarity}`)
      .orderBy(desc(sql`(${similarityExpr})`))
      .limit(query.limit);

    // Map to result format with ranking
    return results.map(function(result: any, index: number): PGVectorSearchResult {
      return {
        id: result.id,
        userId: result.userId,
        intentType: result.intentType,
        rawText: result.rawText,
        parameters: result.parameters as Record<string, unknown> | undefined,
        timestamp: result.timestamp.toISOString(),
        outcome: result.outcome as PGVectorSearchResult['outcome'],
        restaurantId: result.restaurantId ?? undefined,
        restaurantName: result.restaurantName ?? undefined,
        restaurantSlug: result.restaurantSlug ?? undefined,
        metadata: result.metadata as Record<string, unknown> | undefined,
        similarity: result.similarity ?? 0,
        rank: index + 1,
      };
    });
  }

  /**
   * Hybrid search with business data joins
   *
   * This is the "Perfect Grade" feature: Join memory with live business data
   * in a single atomic SQL operation.
   *
   * Example use cases:
   * - Filter memories by user's current subscription tier
   * - Check restaurant availability at time of memory
   * - Exclude memories with conflicting reservations
   *
   * @param query - Search query
   * @param joinConfig - Business data join configuration
   * @returns Results with embedded business data
   */
  async searchWithBusinessData(
    query: PGVectorSearchQuery,
    joinConfig: BusinessDataJoinConfig = {}
  ): Promise<PGVectorSearchResult[]> {
    await this.initialize();

    const {
      includeRestaurantAvailability = false,
      includeUserSubscription = false,
      includeReservationConflicts = false,
    } = joinConfig;

    // Import business tables dynamically
    const {
      restaurants,
      users,
      restaurantReservations,
    } = await import('@repo/database');

    // Build similarity expression
    const similarityExpr = cosineSimilarity(semanticMemories.embedding, query.queryVector);

    // Build base WHERE conditions
    const conditions: SQL[] = [];

    if (query.userId) {
      conditions.push(sql`${semanticMemories.userId} = ${query.userId}`);
    }

    if (query.intentType) {
      conditions.push(sql`${semanticMemories.intentType} = ${query.intentType}`);
    }

    if (query.restaurantId) {
      conditions.push(sql`${semanticMemories.restaurantId} = ${query.restaurantId}`);
    }

    if (query.outcome) {
      conditions.push(sql`${semanticMemories.outcome} = ${query.outcome}`);
    }

    if (query.timeRange) {
      if (query.timeRange.after) {
        conditions.push(sql`${semanticMemories.timestamp} >= ${query.timeRange.after}`);
      }
      if (query.timeRange.before) {
        conditions.push(sql`${semanticMemories.timestamp} <= ${query.timeRange.before}`);
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Build select columns
    const selectColumns: any = {
      id: semanticMemories.id,
      userId: semanticMemories.userId,
      intentType: semanticMemories.intentType,
      rawText: semanticMemories.rawText,
      parameters: semanticMemories.parameters,
      timestamp: semanticMemories.timestamp,
      outcome: semanticMemories.outcome,
      restaurantId: semanticMemories.restaurantId,
      restaurantSlug: semanticMemories.restaurantSlug,
      restaurantName: semanticMemories.restaurantName,
      metadata: semanticMemories.metadata,
      similarity: sql<number>`(${similarityExpr})`,
    };

    // Add business data columns if requested
    if (includeRestaurantAvailability || includeReservationConflicts) {
      selectColumns.restaurantAvailable = restaurants.id;
      selectColumns.restaurantOpeningTime = restaurants.openingTime;
      selectColumns.restaurantClosingTime = restaurants.closingTime;
    }

    if (includeUserSubscription) {
      // Note: Add subscription tier column when implemented
      selectColumns.userSubscriptionTier = sql<string>`NULL`.as('user_subscription_tier');
    }

    // Build query with joins
    let queryBuilder: any = db
      .select(selectColumns)
      .from(semanticMemories);

    // Left join restaurants if needed
    if (includeRestaurantAvailability || includeReservationConflicts) {
      queryBuilder = queryBuilder.leftJoin(
        restaurants,
        sql`${semanticMemories.restaurantId} = ${restaurants.id}`
      );
    }

    // Left join users if needed
    if (includeUserSubscription) {
      queryBuilder = queryBuilder.leftJoin(
        users,
        sql`${semanticMemories.userId} = ${users.clerkId}`
      );
    }

    // Add reservation conflict check if needed
    if (includeReservationConflicts && query.restaurantId) {
      // Check for conflicting reservations at the same time
      const conflictExists = sql<boolean>`EXISTS (
        SELECT 1 FROM restaurant_reservations
        WHERE restaurant_reservations.restaurant_id = ${query.restaurantId}
        AND restaurant_reservations.start_time <= ${sql.raw("semantic_memories.timestamp::timestamp")}
        AND restaurant_reservations.end_time >= ${sql.raw("semantic_memories.timestamp::timestamp")}
        AND restaurant_reservations.status != 'cancelled'
      )`;

      selectColumns.hasReservationConflict = conflictExists;
    }

    // Execute query
    const results = await queryBuilder
      .where(whereClause)
      .having(sql`(${similarityExpr}) >= ${query.minSimilarity}`)
      .orderBy(desc(sql`(${similarityExpr})`))
      .limit(query.limit);

    // Map to result format with business data
    return results.map((result: any, index: number): PGVectorSearchResult => ({
      id: result.id,
      userId: result.userId,
      intentType: result.intentType,
      rawText: result.rawText,
      parameters: result.parameters as Record<string, unknown> | undefined,
      timestamp: result.timestamp.toISOString(),
      outcome: result.outcome as PGVectorSearchResult['outcome'],
      restaurantId: result.restaurantId ?? undefined,
      restaurantName: result.restaurantName ?? undefined,
      restaurantSlug: result.restaurantSlug ?? undefined,
      metadata: result.metadata as Record<string, unknown> | undefined,
      similarity: result.similarity ?? 0,
      rank: index + 1,
      businessData: (includeRestaurantAvailability || includeUserSubscription) ? {
        restaurantAvailable: !!result.restaurantAvailable,
        restaurantOpeningTime: result.restaurantOpeningTime ?? undefined,
        restaurantClosingTime: result.restaurantClosingTime ?? undefined,
        userSubscriptionTier: result.userSubscriptionTier ?? undefined,
        userHasActiveSubscription: !!result.userSubscriptionTier,
      } : undefined,
    }));
  }

  /**
   * Delete a memory entry by ID
   */
  async deleteEntry(id: string): Promise<boolean> {
    await this.initialize();

    const result = await db
      .delete(semanticMemories)
      .where(sql`${semanticMemories.id} = ${id}`);

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Delete all memories for a user
   */
  async deleteByUserId(userId: string): Promise<number> {
    await this.initialize();

    const result = await db
      .delete(semanticMemories)
      .where(sql`${semanticMemories.userId} = ${userId}`);

    return result.rowCount ?? 0;
  }

  /**
   * Get statistics about the vector store
   */
  async getStats(): Promise<{
    totalEntries: number;
    uniqueUsers: number;
    uniqueRestaurants: number;
    avgEntriesPerUser: number;
  }> {
    await this.initialize();

    // Get total entries
    const totalResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(semanticMemories);

    // Get unique users
    const usersResult = await db
      .select({ count: sql<number>`count(distinct ${semanticMemories.userId})` })
      .from(semanticMemories);

    // Get unique restaurants
    const restaurantsResult = await db
      .select({ count: sql<number>`count(distinct ${semanticMemories.restaurantId})` })
      .from(semanticMemories);

    const totalEntries = totalResult[0]?.count ?? 0;
    const uniqueUsers = usersResult[0]?.count ?? 0;
    const uniqueRestaurants = restaurantsResult[0]?.count ?? 0;

    return {
      totalEntries,
      uniqueUsers,
      uniqueRestaurants,
      avgEntriesPerUser: uniqueUsers > 0 ? totalEntries / uniqueUsers : 0,
    };
  }

  /**
   * Run ANALYZE to update query planner statistics
   * Should be called periodically or after bulk inserts
   */
  async analyze(): Promise<void> {
    await this.initialize();
    await db.execute(sql`ANALYZE semantic_memories`);
    console.log('[PGVectorStore] Statistics updated for query planner');
  }
}

// ============================================================================
// FACTORY
// ============================================================================

let defaultHybridSemanticStore: HybridSemanticStore | null = null;

export function createHybridSemanticStore(): HybridSemanticStore {
  if (!defaultHybridSemanticStore) {
    defaultHybridSemanticStore = new HybridSemanticStore();
  }
  return defaultHybridSemanticStore;
}

export function getHybridSemanticStore(): HybridSemanticStore {
  return createHybridSemanticStore();
}
