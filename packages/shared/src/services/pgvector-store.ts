/**
 * PGVector Store Implementation
 *
 * Implements the VectorStore interface using Neon pgvector.
 * Provides hybrid vector-relational search with full ACID transactions.
 *
 * Features:
 * - Cosine similarity search with ivfflat indexing
 * - Metadata filtering (userId, intentType, restaurantId)
 * - Combined vector + relational queries in single transaction
 * - No need for outbox sync - vectors and business data in same DB
 *
 * Usage:
 * ```ts
 * const vectorStore = createPGVectorStore();
 *
 * // Add vector
 * await vectorStore.addVector({
 *   userId: 'user-123',
 *   intentType: 'book_restaurant',
 *   rawText: 'Book Italian restaurant',
 *   embedding: [0.1, 0.2, ...],
 *   parameters: { partySize: 2 },
 *   timestamp: new Date().toISOString(),
 * });
 *
 * // Search
 * const results = await vectorStore.search({
 *   queryVector: [0.1, 0.2, ...],
 *   userId: 'user-123',
 *   limit: 5,
 *   minScore: 0.7,
 * });
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { db, semanticMemories, cosineSimilarity, type SemanticMemory } from '@repo/database';
import { eq, and, gte, lte, sql, desc } from 'drizzle-orm';
import type { VectorStore, VectorEntry, VectorSearchQuery, VectorSearchResult } from './vector-store';

// ============================================================================
// PGVECTOR STORE IMPLEMENTATION
// ============================================================================

export interface PGVectorStoreConfig {
  /** Vector dimensions (default: 384) */
  dimensions?: number;
  /** Minimum similarity threshold (default: 0.5) */
  defaultMinSimilarity?: number;
  /** Default search limit (default: 10) */
  defaultLimit?: number;
}

export class PGVectorStore implements VectorStore {
  private config: Required<PGVectorStoreConfig>;

  constructor(config: PGVectorStoreConfig = {}) {
    this.config = {
      dimensions: config.dimensions || 384,
      defaultMinSimilarity: config.defaultMinSimilarity || 0.5,
      defaultLimit: config.defaultLimit || 10,
    };
  }

  // ========================================================================
  // INTERFACE IMPLEMENTATIONS
  // ========================================================================

  /**
   * Initialize the vector index (no-op for pgvector - schema managed by migrations)
   */
  async initialize(): Promise<void> {
    // pgvector schema is managed by Drizzle migrations
    // No runtime initialization needed
  }

  /**
   * Reset/clear the index (use with caution!)
   */
  async reset(): Promise<void> {
    await this.clearAll();
  }

  // ========================================================================
  // VECTOR OPERATIONS
  // ========================================================================

  /**
   * Add a vector entry to the store
   * Can be used within a transaction for ACID consistency
   */
  async addVector(entry: Omit<VectorEntry, "id">): Promise<string> {
    const id = crypto.randomUUID();

    // Validate embedding dimensions
    if (entry.embedding.length !== this.config.dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.config.dimensions}, got ${entry.embedding.length}`
      );
    }

    // Insert into database
    const inserted = await db.insert(semanticMemories).values({
      id,
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
    }).returning();

    console.log(
      `[PGVectorStore] Added vector ${id} for user ${entry.userId} ` +
      `(${entry.intentType})`
    );

    return id;
  }

  /**
   * Search for similar vectors
   * Uses cosine similarity with ivfflat index for fast approximate search
   */
  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const {
      queryVector,
      userId,
      limit = this.config.defaultLimit,
      minScore = this.config.defaultMinSimilarity,
      filter,
    } = query;

    // Validate query vector dimensions
    if (queryVector.length !== this.config.dimensions) {
      throw new Error(
        `Query vector dimension mismatch: expected ${this.config.dimensions}, got ${queryVector.length}`
      );
    }

    // Build filter conditions
    const conditions = [];

    if (userId) {
      conditions.push(eq(semanticMemories.userId, userId));
    }

    if (filter) {
      // Add metadata filters
      if (filter.intentType) {
        conditions.push(eq(semanticMemories.intentType, filter.intentType as string));
      }
      if (filter.restaurantId) {
        conditions.push(eq(semanticMemories.restaurantId, filter.restaurantId as string));
      }
    }

    // Build similarity computation
    const similarityExpr = cosineSimilarity(semanticMemories.embedding, queryVector);

    // Execute query
    const results = await db
      .select({
        entry: semanticMemories,
        similarity: similarityExpr,
      })
      .from(semanticMemories)
      .where(
        conditions.length > 0
          ? and(...conditions, sql`${similarityExpr} >= ${minScore}`)
          : sql`${similarityExpr} >= ${minScore}`
      )
      .orderBy(desc(similarityExpr))
      .limit(limit);

    // Convert to VectorSearchResult format
    return results.map((result: { entry: typeof semanticMemories.$inferSelect; similarity: number }, index: number) => ({
      id: result.entry.id,
      score: result.similarity,
      metadata: {
        userId: result.entry.userId,
        intentType: result.entry.intentType,
        rawText: result.entry.rawText,
        parameters: result.entry.parameters,
        timestamp: result.entry.timestamp.toISOString(),
        executionId: result.entry.executionId,
        restaurantId: result.entry.restaurantId,
        restaurantSlug: result.entry.restaurantSlug,
        restaurantName: result.entry.restaurantName,
        outcome: result.entry.outcome,
        metadata: result.entry.metadata,
      },
      rank: index + 1,
    }));
  }

  /**
   * Get a vector entry by ID
   */
  async getVector(id: string): Promise<VectorEntry | null> {
    const results = await db
      .select()
      .from(semanticMemories)
      .where(eq(semanticMemories.id, id))
      .limit(1);

    if (results.length === 0) return null;

    const entry = results[0];

    return {
      id: entry.id,
      userId: entry.userId,
      intentType: entry.intentType,
      rawText: entry.rawText,
      embedding: entry.embedding as unknown as number[],
      parameters: entry.parameters as Record<string, unknown> | undefined,
      timestamp: entry.timestamp.toISOString(),
      executionId: entry.executionId,
      restaurantId: entry.restaurantId,
      restaurantSlug: entry.restaurantSlug,
      restaurantName: entry.restaurantName,
      outcome: entry.outcome,
      metadata: entry.metadata,
    };
  }

  /**
   * Delete a vector entry by ID
   */
  async deleteVector(id: string): Promise<boolean> {
    const result = await db
      .delete(semanticMemories)
      .where(eq(semanticMemories.id, id));

    const deleted = result.rowCount || 0;
    console.log(`[PGVectorStore] Deleted vector ${id} (${deleted} rows)`);
    return deleted > 0;
  }

  /**
   * Delete all vectors for a user
   */
  async deleteByUserId(userId: string): Promise<number> {
    const result = await db
      .delete(semanticMemories)
      .where(eq(semanticMemories.userId, userId));

    const deleted = result.rowCount || 0;
    console.log(`[PGVectorStore] Deleted ${deleted} vectors for user ${userId}`);
    return deleted;
  }

  /**
   * Update vector metadata
   */
  async updateMetadata(
    id: string,
    metadata: Record<string, unknown>
  ): Promise<boolean> {
    const result = await db
      .update(semanticMemories)
      .set({
        metadata,
      })
      .where(eq(semanticMemories.id, id));

    const updated = result.rowCount || 0;
    console.log(`[PGVectorStore] Updated metadata for vector ${id} (${updated} rows)`);
    return updated > 0;
  }

  // ========================================================================
  // STATISTICS
  // ========================================================================

  /**
   * Get statistics about the vector store
   */
  async getStats(): Promise<{
    totalVectors: number;
    uniqueUsers: number;
    uniqueRestaurants: number;
    avgVectorsPerUser: number;
  }> {
    // Get total vectors
    const totalResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(semanticMemories);

    const totalVectors = totalResult[0]?.count || 0;

    // Get unique users
    const usersResult = await db
      .select({ count: sql<number>`count(distinct ${semanticMemories.userId})` })
      .from(semanticMemories);

    const uniqueUsers = usersResult[0]?.count || 0;

    // Get unique restaurants
    const restaurantsResult = await db
      .select({ count: sql<number>`count(distinct ${semanticMemories.restaurantId})` })
      .from(semanticMemories);

    const uniqueRestaurants = restaurantsResult[0]?.count || 0;

    return {
      totalVectors,
      uniqueUsers,
      uniqueRestaurants,
      avgVectorsPerUser: uniqueUsers > 0 ? totalVectors / uniqueUsers : 0,
    };
  }

  // ========================================================================
  // BATCH OPERATIONS
  // ========================================================================

  /**
   * Add multiple vectors in batch
   * More efficient than individual inserts
   */
  async addVectors(entries: Array<Omit<VectorEntry, "id">>): Promise<string[]> {
    const ids: string[] = [];

    // Process in batches of 100 to avoid overwhelming the database
    const batchSize = 100;

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);

      const values = batch.map(entry => {
        const id = crypto.randomUUID();
        ids.push(id);

        if (entry.embedding.length !== this.config.dimensions) {
          throw new Error(
            `Embedding dimension mismatch: expected ${this.config.dimensions}, got ${entry.embedding.length}`
          );
        }

        return {
          id,
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
        };
      });

      await db.insert(semanticMemories).values(values);

      console.log(
        `[PGVectorStore] Batch inserted ${batch.length} vectors (${i + batch.length}/${entries.length})`
      );
    }

    return ids;
  }

  /**
   * Clear all vectors (use with caution!)
   */
  async clearAll(): Promise<number> {
    const result = await db.delete(semanticMemories);
    const deleted = result.rowCount || 0;
    console.log(`[PGVectorStore] Cleared all vectors (${deleted} rows)`);
    return deleted;
  }
}

// ============================================================================
// FACTORY
// Create PGVector store instance
// ============================================================================

export function createPGVectorStore(config?: PGVectorStoreConfig): PGVectorStore {
  return new PGVectorStore(config);
}
