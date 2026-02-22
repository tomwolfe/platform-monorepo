/**
 * Vector Store for Semantic Memory
 * 
 * Enables similarity-based retrieval of historical interactions for
 * true conversational continuity and context-aware intent inference.
 * 
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";
import { Redis } from "@upstash/redis";

// ============================================================================
// SCHEMAS
// ============================================================================

/**
 * Semantic memory entry schema
 */
export const SemanticMemoryEntrySchema = z.object({
  id: z.string().uuid(),
  userId: z.string(), // clerkId or IP
  intentType: z.string(),
  rawText: z.string(),
  parameters: z.record(z.unknown()).optional(),
  embedding: z.array(z.number()), // 384-dim vector (all-MiniLM-L6-v2)
  timestamp: z.string().datetime(),
  executionId: z.string().uuid().optional(),
  restaurantId: z.string().uuid().optional(),
  restaurantSlug: z.string().optional(),
  restaurantName: z.string().optional(),
  outcome: z.enum(["success", "failed", "partial", "abandoned"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type SemanticMemoryEntry = z.infer<typeof SemanticMemoryEntrySchema>;

/**
 * Search result with similarity score
 */
export const SemanticSearchResultSchema = z.object({
  entry: SemanticMemoryEntrySchema,
  similarity: z.number().min(0).max(1),
  rank: z.number().int().positive(),
});

export type SemanticSearchResult = z.infer<typeof SemanticSearchResultSchema>;

/**
 * Search query parameters
 */
export const SemanticSearchQuerySchema = z.object({
  query: z.string(),
  queryEmbedding: z.array(z.number()).optional(),
  userId: z.string().optional(),
  intentType: z.string().optional(),
  restaurantId: z.string().uuid().optional(),
  limit: z.number().int().positive().max(100).default(5),
  minSimilarity: z.number().min(0).max(1).default(0.5),
  timeRange: z.object({
    after: z.string().datetime().optional(),
    before: z.string().datetime().optional(),
  }).optional(),
  includeFailed: z.boolean().default(false),
});

export type SemanticSearchQuery = z.infer<typeof SemanticSearchQuerySchema>;

// ============================================================================
// EMBEDDING SERVICE INTERFACE
// Abstract interface for embedding generation
// ============================================================================

export interface EmbeddingService {
  /**
   * Generate embedding for text
   * Returns array of numbers (typically 384 or 768 dimensions)
   */
  generateEmbedding(text: string): Promise<number[]>;

  /**
   * Generate embeddings for multiple texts in batch
   */
  generateEmbeddings(texts: string[]): Promise<number[][]>;

  /**
   * Compute cosine similarity between two vectors
   */
  cosineSimilarity(a: number[], b: number[]): number;
}

/**
 * Default embedding service using Hugging Face Inference API
 * Model: sentence-transformers/all-MiniLM-L6-v2 (384 dimensions)
 */
export class HuggingFaceEmbeddingService implements EmbeddingService {
  private apiKey: string;
  private modelUrl: string;

  constructor(apiKey: string, modelUrl?: string) {
    this.apiKey = apiKey;
    this.modelUrl = modelUrl || "https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2";
  }

  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const response = await fetch(this.modelUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: text }),
      });

      if (!response.ok) {
        throw new Error(`Hugging Face API error: ${response.statusText}`);
      }

      const result = await response.json();
      
      // Handle different response formats
      const embedding = Array.isArray(result) ? result[0] : result.embedding;
      
      if (!Array.isArray(embedding)) {
        throw new Error("Invalid embedding format from API");
      }

      return embedding as number[];
    } catch (error) {
      console.error("[EmbeddingService] Failed to generate embedding:", error);
      // Fallback: return zero vector (will have low similarity to everything)
      return new Array(384).fill(0);
    }
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    // Process in batches to avoid rate limits
    const batchSize = 5;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(text => this.generateEmbedding(text))
      );
      results.push(...batchResults);
      
      // Small delay between batches
      if (i + batchSize < texts.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return results;
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error("Vectors must have same dimension");
    }

    if (a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

/**
 * Mock embedding service for development/testing
 * Returns deterministic pseudo-embeddings based on text hash
 */
export class MockEmbeddingService implements EmbeddingService {
  private dimensions: number;

  constructor(dimensions: number = 384) {
    this.dimensions = dimensions;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    // Simple hash-based pseudo-embedding
    const embedding: number[] = [];
    let hash = 0;

    for (let i = 0; i < this.dimensions; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i % text.length)) | 0;
      // Normalize to [-1, 1] range
      embedding.push((hash % 1000) / 1000);
    }

    // Normalize vector
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (norm > 0) {
      for (let i = 0; i < this.dimensions; i++) {
        embedding[i] /= norm;
      }
    }

    return embedding;
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(text => this.generateEmbedding(text)));
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

// ============================================================================
// VECTOR STORE
// Redis-based vector storage with brute-force similarity search
// Note: For production scale, consider Upstash Vector, Pinecone, or pgvector
// ============================================================================

export interface VectorStoreConfig {
  redis: Redis;
  embeddingService: EmbeddingService;
  indexName?: string;
  dimensions?: number;
  ttlSeconds?: number;
}

export class SemanticVectorStore {
  private redis: Redis;
  private embeddingService: EmbeddingService;
  private indexName: string;
  private dimensions: number;
  private ttlSeconds?: number;

  constructor(config: VectorStoreConfig) {
    this.redis = config.redis;
    this.embeddingService = config.embeddingService;
    this.indexName = config.indexName || "semantic_memory";
    this.dimensions = config.dimensions || 384;
    this.ttlSeconds = config.ttlSeconds;
  }

  /**
   * Build key for storing an entry
   */
  private buildKey(entryId: string): string {
    return `${this.indexName}:entry:${entryId}`;
  }

  /**
   * Build key for user index (sorted set by timestamp)
   */
  private buildUserIndexKey(userId: string): string {
    return `${this.indexName}:user:${userId}`;
  }

  /**
   * Build key for restaurant index
   */
  private buildRestaurantIndexKey(restaurantId: string): string {
    return `${this.indexName}:restaurant:${restaurantId}`;
  }

  /**
   * Add a new memory entry to the vector store
   */
  async addEntry(entry: Omit<SemanticMemoryEntry, "embedding">): Promise<SemanticMemoryEntry> {
    // Generate embedding
    const textForEmbedding = this.buildEmbeddingText(entry);
    const embedding = await this.embeddingService.generateEmbedding(textForEmbedding);

    const completeEntry: SemanticMemoryEntry = {
      ...entry,
      embedding,
    };

    // Store entry
    const key = this.buildKey(entry.id);
    const entryJson = JSON.stringify(completeEntry);

    if (this.ttlSeconds) {
      await this.redis.setex(key, this.ttlSeconds, entryJson);
    } else {
      await this.redis.set(key, entryJson);
    }

    // Add to user index (sorted set by timestamp)
    const userIndexKey = this.buildUserIndexKey(entry.userId);
    const timestamp = new Date(entry.timestamp).getTime();
    await this.redis.zadd(userIndexKey, {
      member: entry.id,
      score: timestamp,
    });

    // Add to restaurant index if applicable
    if (entry.restaurantId) {
      const restaurantIndexKey = this.buildRestaurantIndexKey(entry.restaurantId);
      await this.redis.zadd(restaurantIndexKey, {
        member: entry.id,
        score: timestamp,
      });
    }

    console.log(`[VectorStore] Added entry ${entry.id} for user ${entry.userId}`);
    return completeEntry;
  }

  /**
   * Search for similar memories
   * 
   * PERFORMANCE FIX: Replaced redis.keys() with SCAN to avoid blocking Redis
   * - redis.keys() is O(N) and blocks the single-threaded Redis event loop
   * - SCAN is non-blocking and allows incremental iteration
   * - Added strict candidate limits to prevent timeout cascades
   * 
   * PRODUCTION RECOMMENDATION: For >10k memories, migrate to:
   * - Upstash Vector (managed vector database)
   * - Neon pgvector (Postgres with vector extension)
   * - RedisVL (Redis Vector Library with HNSW indexes for O(log N) search)
   */
  async search(query: SemanticSearchQuery): Promise<SemanticSearchResult[]> {
    let queryEmbedding = query.queryEmbedding;

    // Generate embedding if not provided
    if (!queryEmbedding) {
      queryEmbedding = await this.embeddingService.generateEmbedding(query.query);
    }

    // Determine which index to search
    let candidateIds: string[];

    if (query.restaurantId) {
      // Search within restaurant context
      const restaurantIndexKey = this.buildRestaurantIndexKey(query.restaurantId);
      candidateIds = await this.redis.zrange(restaurantIndexKey, 0, -1) as string[];
    } else if (query.userId) {
      // Search within user history
      const userIndexKey = this.buildUserIndexKey(query.userId);

      // Apply time range filter if specified
      const minScore = query.timeRange?.after ? new Date(query.timeRange.after).getTime() : "-inf" as const;
      const maxScore = query.timeRange?.before ? new Date(query.timeRange.before).getTime() : "+inf" as const;

      candidateIds = await this.redis.zrange(
        userIndexKey,
        minScore,
        maxScore,
        { byScore: true }
      ) as string[];
    } else {
      // Global search - use SCAN instead of KEYS to avoid blocking Redis
      // SCAN is non-blocking and allows incremental iteration
      candidateIds = await this.scanForKeys(`${this.indexName}:entry:*`, 1000);
    }

    // PERFORMANCE FIX: Strict limit on candidates to prevent timeout cascades
    // With >10k memories, this brute-force approach will be too slow
    // Production systems should migrate to vector databases (Upstash Vector, pgvector, RedisVL)
    const MAX_CANDIDATES = 500; // Reduced from 100 to be more conservative
    if (candidateIds.length > MAX_CANDIDATES) {
      console.warn(
        `[VectorStore] Candidate set (${candidateIds.length}) exceeds limit (${MAX_CANDIDATES}). ` +
        `Consider migrating to a dedicated vector database for production scale.`
      );
      // Take most recent candidates (already sorted by timestamp in indexed searches)
      candidateIds = candidateIds.slice(0, MAX_CANDIDATES);
    }

    // Compute similarities (brute-force)
    const results: Array<{ entry: SemanticMemoryEntry; similarity: number }> = [];

    for (const entryId of candidateIds) {
      const key = this.buildKey(entryId);
      const entryData = await this.redis.get<any>(key);

      if (!entryData) continue;

      try {
        // Redis may auto-deserialize JSON, so check if already an object
        const entry: SemanticMemoryEntry = typeof entryData === 'string'
          ? JSON.parse(entryData)
          : entryData;

        // Filter by intent type if specified
        if (query.intentType && entry.intentType !== query.intentType) {
          continue;
        }

        // Filter failed entries if requested
        if (!query.includeFailed && entry.outcome === "failed") {
          continue;
        }

        // Compute similarity
        const similarity = this.embeddingService.cosineSimilarity(
          queryEmbedding!,
          entry.embedding
        );

        if (similarity >= query.minSimilarity) {
          results.push({ entry, similarity });
        }
      } catch (error) {
        console.warn(`[VectorStore] Failed to parse entry ${entryId}:`, error);
      }
    }

    // Sort by similarity and limit results
    results.sort((a, b) => b.similarity - a.similarity);

    return results.slice(0, query.limit).map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  /**
   * Scan for keys matching a pattern without blocking Redis
   * Uses SCAN command instead of KEYS for production safety
   * 
   * @param pattern - Key pattern to match (e.g., "index:entry:*")
   * @param maxCount - Maximum number of keys to return (prevents memory issues)
   * @returns Array of matching keys
   */
  private async scanForKeys(pattern: string, maxCount: number = 1000): Promise<string[]> {
    const keys: string[] = [];
    let cursor = 0;
    const batchSize = 100; // Process 100 keys at a time

    do {
      const result = await this.redis.scan(cursor, {
        match: pattern,
        count: batchSize,
      });

      cursor = parseInt(result[0] as string, 10);
      const batchKeys = result[1] as string[];
      
      // Strip prefix from keys (our Redis wrapper adds namespace prefix)
      for (const key of batchKeys) {
        const strippedKey = key.startsWith(`${this.indexName}:entry:`) 
          ? key.replace(`${this.indexName}:entry:`, "")
          : key;
        keys.push(strippedKey);
      }

      // Early exit if we've collected enough keys
      if (keys.length >= maxCount) {
        break;
      }
    } while (cursor !== 0);

    return keys.slice(0, maxCount);
  }

  /**
   * Get most recent memories for a user
   */
  async getRecentMemories(userId: string, limit: number = 10): Promise<SemanticMemoryEntry[]> {
    const userIndexKey = this.buildUserIndexKey(userId);
    // Use zrange with negative indices for reverse order (most recent first)
    const entryIds = await this.redis.zrange(userIndexKey, -limit, -1) as string[];

    const entries: SemanticMemoryEntry[] = [];

    for (const entryId of entryIds) {
      const key = this.buildKey(entryId);
      const entryData = await this.redis.get<any>(key);

      if (entryData) {
        try {
          // Redis may auto-deserialize JSON, so check if already an object
          const entry: SemanticMemoryEntry = typeof entryData === 'string' 
            ? JSON.parse(entryData) 
            : entryData;
          entries.push(entry);
        } catch (error) {
          console.warn(`[VectorStore] Failed to parse entry ${entryId}:`, error);
        }
      }
    }

    return entries;
  }

  /**
   * Delete a memory entry
   */
  async deleteEntry(entryId: string): Promise<boolean> {
    const key = this.buildKey(entryId);
    const entryData = await this.redis.get<any>(key);

    if (!entryData) return false;

    try {
      // Redis may auto-deserialize JSON, so check if already an object
      const entry: SemanticMemoryEntry = typeof entryData === 'string' 
        ? JSON.parse(entryData) 
        : entryData;

      // Remove from user index
      const userIndexKey = this.buildUserIndexKey(entry.userId);
      await this.redis.zrem(userIndexKey, entryId);

      // Remove from restaurant index if applicable
      if (entry.restaurantId) {
        const restaurantIndexKey = this.buildRestaurantIndexKey(entry.restaurantId);
        await this.redis.zrem(restaurantIndexKey, entryId);
      }

      // Delete entry
      await this.redis.del(key);
      return true;
    } catch (error) {
      console.error(`[VectorStore] Failed to delete entry ${entryId}:`, error);
      return false;
    }
  }

  /**
   * Clear all memories for a user
   */
  async clearUserMemories(userId: string): Promise<number> {
    const userIndexKey = this.buildUserIndexKey(userId);
    const entryIds = await this.redis.zrange(userIndexKey, 0, -1) as string[];

    let deletedCount = 0;

    for (const entryId of entryIds) {
      const deleted = await this.deleteEntry(entryId);
      if (deleted) deletedCount++;
    }

    // Delete the index itself
    await this.redis.del(userIndexKey);

    return deletedCount;
  }

  /**
   * Get statistics about the vector store
   * 
   * PERFORMANCE FIX: Uses SCAN instead of KEYS to avoid blocking Redis
   */
  async getStats(): Promise<{
    totalEntries: number;
    uniqueUsers: number;
    uniqueRestaurants: number;
    avgEntriesPerUser: number;
  }> {
    // Use SCAN instead of KEYS to avoid blocking Redis
    const entryKeys = await this.scanForKeys(`${this.indexName}:entry:*`, 10000);
    const totalEntries = entryKeys.length;

    // Count unique users
    const userIndexKeys = await this.scanForKeys(`${this.indexName}:user:*`, 1000);
    const uniqueUsers = userIndexKeys.length;

    // Count unique restaurants
    const restaurantIndexKeys = await this.scanForKeys(`${this.indexName}:restaurant:*`, 1000);
    const uniqueRestaurants = restaurantIndexKeys.length;

    return {
      totalEntries,
      uniqueUsers,
      uniqueRestaurants,
      avgEntriesPerUser: uniqueUsers > 0 ? totalEntries / uniqueUsers : 0,
    };
  }

  /**
   * Build text for embedding generation
   * Combines all relevant fields for rich semantic representation
   */
  private buildEmbeddingText(entry: Omit<SemanticMemoryEntry, "embedding">): string {
    const parts: string[] = [
      entry.rawText,
      entry.intentType,
    ];

    if (entry.parameters) {
      // Add parameter values as text
      const paramText = Object.entries(entry.parameters)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ");
      parts.push(paramText);
    }

    if (entry.restaurantName) {
      parts.push(`restaurant: ${entry.restaurantName}`);
    }

    if (entry.outcome) {
      parts.push(`outcome: ${entry.outcome}`);
    }

    return parts.join(" | ");
  }
}

// ============================================================================
// FACTORY
// Create vector store with default configuration
// ============================================================================

export function createSemanticVectorStore(options?: {
  redis?: Redis;
  embeddingApiKey?: string;
  useMockEmbeddings?: boolean;
  indexName?: string;
  ttlSeconds?: number;
}): SemanticVectorStore {
  const { getRedisClient, ServiceNamespace } = require("../redis");

  const redis = options?.redis || getRedisClient(ServiceNamespace.SHARED);

  let embeddingService: EmbeddingService;

  // Check for HuggingFace API key in options or environment
  const apiKey = options?.embeddingApiKey || process.env.HUGGINGFACE_API_KEY;
  const modelUrl = process.env.HUGGINGFACE_MODEL_URL;

  if (options?.useMockEmbeddings || !apiKey) {
    embeddingService = new MockEmbeddingService(384);
    console.log("[VectorStore] Using mock embedding service (set HUGGINGFACE_API_KEY for real embeddings)");
  } else {
    embeddingService = new HuggingFaceEmbeddingService(apiKey, modelUrl);
    console.log("[VectorStore] Using Hugging Face embedding service");
  }

  return new SemanticVectorStore({
    redis,
    embeddingService,
    indexName: options?.indexName,
    ttlSeconds: options?.ttlSeconds,
  });
}
