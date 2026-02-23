/**
 * Vector Store Abstraction Layer
 *
 * Provides a unified interface for vector storage with support for:
 * - Upstash Vector (managed, production-ready)
 * - Redis with brute-force (development/legacy)
 * - pgvector (self-hosted PostgreSQL)
 *
 * This abstraction allows seamless migration from O(N) brute-force
 * to O(log N) indexed vector search without changing application code.
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
 * Vector index configuration
 */
export const VectorIndexConfigSchema = z.object({
  /** Index name/identifier */
  indexName: z.string().default("semantic_memory"),
  /** Vector dimensions (384 for all-MiniLM-L6-v2) */
  dimensions: z.number().int().positive().default(384),
  /** Distance metric: cosine, euclidean, dot */
  metric: z.enum(["cosine", "euclidean", "dot"]).default("cosine"),
  /** Number of clusters for HNSW index */
  clusters: z.number().int().positive().default(16),
  /** Vector capacity (max vectors in index) */
  capacity: z.number().int().positive().default(100000),
});

export type VectorIndexConfig = z.infer<typeof VectorIndexConfigSchema>;

/**
 * Vector entry for storage
 */
export const VectorEntrySchema = z.object({
  id: z.string().uuid(),
  userId: z.string(),
  intentType: z.string(),
  rawText: z.string(),
  parameters: z.record(z.unknown()).optional(),
  embedding: z.array(z.number()),
  timestamp: z.string().datetime(),
  executionId: z.string().uuid().optional(),
  restaurantId: z.string().uuid().optional(),
  restaurantSlug: z.string().optional(),
  restaurantName: z.string().optional(),
  outcome: z.enum(["success", "failed", "partial", "abandoned"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type VectorEntry = z.infer<typeof VectorEntrySchema>;

/**
 * Search result with similarity score
 */
export const VectorSearchResultSchema = z.object({
  id: z.string(),
  score: z.number().min(0).max(1),
  metadata: z.record(z.unknown()),
});

export type VectorSearchResult = z.infer<typeof VectorSearchResultSchema>;

/**
 * Search query parameters
 */
export const VectorSearchQuerySchema = z.object({
  queryVector: z.array(z.number()),
  userId: z.string().optional(),
  intentType: z.string().optional(),
  restaurantId: z.string().uuid().optional(),
  limit: z.number().int().positive().max(100).default(5),
  minScore: z.number().min(0).max(1).default(0.5),
  filter: z.record(z.unknown()).optional(),
});

export type VectorSearchQuery = z.infer<typeof VectorSearchQuerySchema>;

// ============================================================================
// VECTOR STORE INTERFACE
// Abstract interface for vector operations
// ============================================================================

export interface VectorStore {
  /**
   * Initialize the vector index (create if not exists)
   */
  initialize(): Promise<void>;

  /**
   * Add a vector to the index
   */
  addVector(entry: Omit<VectorEntry, "id">): Promise<string>;

  /**
   * Add multiple vectors in batch
   */
  addVectors(entries: Array<Omit<VectorEntry, "id">>): Promise<string[]>;

  /**
   * Search for similar vectors
   */
  search(query: VectorSearchQuery): Promise<VectorSearchResult[]>;

  /**
   * Delete a vector by ID
   */
  deleteVector(id: string): Promise<boolean>;

  /**
   * Delete vectors by user ID
   */
  deleteByUserId(userId: string): Promise<number>;

  /**
   * Get vector statistics
   */
  getStats(): Promise<{
    totalVectors: number;
    uniqueUsers: number;
    uniqueRestaurants: number;
  }>;

  /**
   * Reset/clear the index
   */
  reset(): Promise<void>;
}

// ============================================================================
// UPSTASH VECTOR IMPLEMENTATION
// Production-ready managed vector database
// ============================================================================

export interface UpstashVectorConfig extends VectorIndexConfig {
  upstashToken: string;
  upstashUrl?: string;
}

export class UpstashVectorStore implements VectorStore {
  private config: UpstashVectorConfig;
  private indexName: string;
  private initialized = false;

  constructor(config: UpstashVectorConfig) {
    this.config = config;
    this.indexName = config.indexName;
  }

  /**
   * Initialize the vector index
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Check if index exists
      const existingIndexes = await this.listIndexes();
      
      if (!existingIndexes.includes(this.indexName)) {
        // Create new index
        await this.createIndex();
        console.log(`[UpstashVector] Created index: ${this.indexName}`);
      } else {
        console.log(`[UpstashVector] Using existing index: ${this.indexName}`);
      }

      this.initialized = true;
    } catch (error) {
      console.error("[UpstashVector] Failed to initialize:", error);
      throw error;
    }
  }

  /**
   * List existing indexes
   */
  private async listIndexes(): Promise<string[]> {
    const response = await fetch(`${this.getBaseUrl()}/index`, {
      method: "GET",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to list indexes: ${response.statusText}`);
    }

    const data = await response.json();
    return data.indexes || [];
  }

  /**
   * Create a new vector index
   */
  private async createIndex(): Promise<void> {
    const response = await fetch(`${this.getBaseUrl()}/index/${this.indexName}`, {
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify({
        dimension: this.config.dimensions,
        metric: this.config.metric,
        clusters: this.config.clusters,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create index: ${response.statusText}`);
    }
  }

  /**
   * Add a vector to the index
   */
  async addVector(entry: Omit<VectorEntry, "id">): Promise<string> {
    await this.initialize();

    const id = crypto.randomUUID();
    
    const response = await fetch(`${this.getBaseUrl()}/index/${this.indexName}/upsert`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        id,
        vector: entry.embedding,
        metadata: {
          userId: entry.userId,
          intentType: entry.intentType,
          rawText: entry.rawText,
          parameters: entry.parameters,
          timestamp: entry.timestamp,
          executionId: entry.executionId,
          restaurantId: entry.restaurantId,
          restaurantSlug: entry.restaurantSlug,
          restaurantName: entry.restaurantName,
          outcome: entry.outcome,
          ...entry.metadata,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to add vector: ${response.statusText}`);
    }

    console.log(`[UpstashVector] Added vector ${id} for user ${entry.userId}`);
    return id;
  }

  /**
   * Add multiple vectors in batch
   */
  async addVectors(entries: Array<Omit<VectorEntry, "id">>): Promise<string[]> {
    await this.initialize();

    const ids: string[] = [];
    const vectors = entries.map(entry => {
      const id = crypto.randomUUID();
      ids.push(id);
      
      return {
        id,
        vector: entry.embedding,
        metadata: {
          userId: entry.userId,
          intentType: entry.intentType,
          rawText: entry.rawText,
          parameters: entry.parameters,
          timestamp: entry.timestamp,
          executionId: entry.executionId,
          restaurantId: entry.restaurantId,
          restaurantSlug: entry.restaurantSlug,
          restaurantName: entry.restaurantName,
          outcome: entry.outcome,
          ...entry.metadata,
        },
      };
    });

    const response = await fetch(`${this.getBaseUrl()}/index/${this.indexName}/upsert`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ vectors }),
    });

    if (!response.ok) {
      throw new Error(`Failed to add vectors: ${response.statusText}`);
    }

    console.log(`[UpstashVector] Added ${vectors.length} vectors`);
    return ids;
  }

  /**
   * Search for similar vectors
   */
  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    await this.initialize();

    // Build filter
    const filter: Record<string, unknown> = {};
    
    if (query.userId) {
      filter.userId = query.userId;
    }
    
    if (query.intentType) {
      filter.intentType = query.intentType;
    }
    
    if (query.restaurantId) {
      filter.restaurantId = query.restaurantId;
    }

    if (query.filter) {
      Object.assign(filter, query.filter);
    }

    const response = await fetch(`${this.getBaseUrl()}/index/${this.indexName}/query`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({
        vector: query.queryVector,
        topK: query.limit,
        includeMetadata: true,
        includeVectors: false,
        filter: Object.keys(filter).length > 0 ? filter : undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to search vectors: ${response.statusText}`);
    }

    const data = await response.json();
    
    return (data.results || [])
      .filter((result: any) => result.score >= query.minScore)
      .map((result: any, index: number) => ({
        id: result.id,
        score: result.score,
        metadata: result.metadata,
        rank: index + 1,
      }));
  }

  /**
   * Delete a vector by ID
   */
  async deleteVector(id: string): Promise<boolean> {
    await this.initialize();

    const response = await fetch(`${this.getBaseUrl()}/index/${this.indexName}/delete`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ ids: [id] }),
    });

    if (!response.ok) {
      throw new Error(`Failed to delete vector: ${response.statusText}`);
    }

    const data = await response.json();
    return data.deleted === 1;
  }

  /**
   * Delete vectors by user ID
   */
  async deleteByUserId(userId: string): Promise<number> {
    await this.initialize();

    // First, search for all vectors by user
    const dummyVector = new Array(this.config.dimensions).fill(0);
    const results = await this.search({
      queryVector: dummyVector,
      userId,
      limit: 10000,
      minScore: 0,
    });

    if (results.length === 0) {
      return 0;
    }

    // Delete all found vectors
    const response = await fetch(`${this.getBaseUrl()}/index/${this.indexName}/delete`, {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify({ ids: results.map(r => r.id) }),
    });

    if (!response.ok) {
      throw new Error(`Failed to delete user vectors: ${response.statusText}`);
    }

    const data = await response.json();
    return data.deleted || 0;
  }

  /**
   * Get vector statistics
   */
  async getStats(): Promise<{
    totalVectors: number;
    uniqueUsers: number;
    uniqueRestaurants: number;
  }> {
    await this.initialize();

    try {
      const response = await fetch(`${this.getBaseUrl()}/index/${this.indexName}/info`, {
        method: "GET",
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to get index info: ${response.statusText}`);
      }

      const info = await response.json();
      
      return {
        totalVectors: info.vectorCount || 0,
        uniqueUsers: info.uniqueUsers || 0,
        uniqueRestaurants: info.uniqueRestaurants || 0,
      };
    } catch (error) {
      console.error("[UpstashVector] Failed to get stats:", error);
      return {
        totalVectors: 0,
        uniqueUsers: 0,
        uniqueRestaurants: 0,
      };
    }
  }

  /**
   * Reset/clear the index
   */
  async reset(): Promise<void> {
    await this.initialize();

    const response = await fetch(`${this.getBaseUrl()}/index/${this.indexName}/reset`, {
      method: "POST",
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to reset index: ${response.statusText}`);
    }

    console.log(`[UpstashVector] Reset index: ${this.indexName}`);
  }

  /**
   * Get base URL for API calls
   */
  private getBaseUrl(): string {
    return this.config.upstashUrl || "https://vector.upstash.io";
  }

  /**
   * Get headers for API calls
   */
  private getHeaders(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.config.upstashToken}`,
      "Content-Type": "application/json",
    };
  }
}

// ============================================================================
// REDIS VECTOR STORE (LEGACY/BRUTE-FORCE)
// Fallback implementation for development
// ============================================================================

export interface RedisVectorStoreConfig extends VectorIndexConfig {
  redis: Redis;
}

export class RedisVectorStore implements VectorStore {
  private redis: Redis;
  private config: VectorIndexConfig;
  private indexName: string;

  constructor(config: RedisVectorStoreConfig) {
    this.redis = config.redis;
    this.config = config;
    this.indexName = config.indexName;
  }

  async initialize(): Promise<void> {
    // No initialization needed for Redis implementation
    console.log(`[RedisVectorStore] Using legacy brute-force search for index: ${this.indexName}`);
  }

  async addVector(entry: Omit<VectorEntry, "id">): Promise<string> {
    const id = crypto.randomUUID();
    const key = this.buildKey(id);
    
    const entryData: VectorEntry = {
      ...entry,
      id,
    };

    await this.redis.set(key, JSON.stringify(entryData));
    
    // Add to user index
    const userIndexKey = `${this.indexName}:user:${entry.userId}`;
    await this.redis.zadd(userIndexKey, {
      member: id,
      score: new Date(entry.timestamp).getTime(),
    });

    console.log(`[RedisVectorStore] Added vector ${id} for user ${entry.userId}`);
    return id;
  }

  async addVectors(entries: Array<Omit<VectorEntry, "id">>): Promise<string[]> {
    const ids = await Promise.all(entries.map(e => this.addVector(e)));
    return ids;
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    // Brute-force similarity search
    let candidateIds: string[];

    if (query.userId) {
      const userIndexKey = `${this.indexName}:user:${query.userId}`;
      candidateIds = await this.redis.zrange(userIndexKey, 0, -1) as string[];
    } else {
      // Global search - use SCAN
      candidateIds = await this.scanForKeys(`${this.indexName}:entry:*`, 1000);
    }

    // Limit candidates to prevent timeout
    const MAX_CANDIDATES = 500;
    if (candidateIds.length > MAX_CANDIDATES) {
      console.warn(
        `[RedisVectorStore] Candidate set (${candidateIds.length}) exceeds limit. ` +
        `Consider migrating to Upstash Vector for production scale.`
      );
      candidateIds = candidateIds.slice(0, MAX_CANDIDATES);
    }

    // Compute similarities
    const results: Array<{ id: string; score: number; metadata: Record<string, unknown> }> = [];

    for (const entryId of candidateIds) {
      const key = this.buildKey(entryId);
      const entryData = await this.redis.get<any>(key);

      if (!entryData) continue;

      try {
        const entry: VectorEntry = typeof entryData === 'string'
          ? JSON.parse(entryData)
          : entryData;

        // Apply filters
        if (query.intentType && entry.intentType !== query.intentType) continue;
        if (query.filter?.restaurantId && entry.restaurantId !== query.filter.restaurantId) continue;

        // Compute cosine similarity
        const similarity = this.cosineSimilarity(query.queryVector, entry.embedding);

        if (similarity >= query.minScore) {
          results.push({
            id: entry.id,
            score: similarity,
            metadata: {
              userId: entry.userId,
              intentType: entry.intentType,
              rawText: entry.rawText,
              timestamp: entry.timestamp,
              restaurantId: entry.restaurantId,
              restaurantName: entry.restaurantName,
              outcome: entry.outcome,
            },
          });
        }
      } catch (error) {
        console.warn(`[RedisVectorStore] Failed to parse entry ${entryId}:`, error);
      }
    }

    // Sort by score and limit
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, query.limit).map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  async deleteVector(id: string): Promise<boolean> {
    const key = this.buildKey(id);
    const entryData = await this.redis.get<any>(key);

    if (!entryData) return false;

    try {
      const entry: VectorEntry = typeof entryData === 'string'
        ? JSON.parse(entryData)
        : entryData;

      // Remove from user index
      const userIndexKey = `${this.indexName}:user:${entry.userId}`;
      await this.redis.zrem(userIndexKey, id);

      // Delete entry
      await this.redis.del(key);
      return true;
    } catch (error) {
      console.error(`[RedisVectorStore] Failed to delete vector ${id}:`, error);
      return false;
    }
  }

  async deleteByUserId(userId: string): Promise<number> {
    const userIndexKey = `${this.indexName}:user:${userId}`;
    const entryIds = await this.redis.zrange(userIndexKey, 0, -1) as string[];

    let deletedCount = 0;

    for (const entryId of entryIds) {
      const deleted = await this.deleteVector(entryId);
      if (deleted) deletedCount++;
    }

    // Delete the index itself
    await this.redis.del(userIndexKey);

    return deletedCount;
  }

  async getStats(): Promise<{
    totalVectors: number;
    uniqueUsers: number;
    uniqueRestaurants: number;
  }> {
    const entryKeys = await this.scanForKeys(`${this.indexName}:entry:*`, 10000);
    const userIndexKeys = await this.scanForKeys(`${this.indexName}:user:*`, 1000);
    const restaurantIndexKeys = await this.scanForKeys(`${this.indexName}:restaurant:*`, 1000);

    return {
      totalVectors: entryKeys.length,
      uniqueUsers: userIndexKeys.length,
      uniqueRestaurants: restaurantIndexKeys.length,
    };
  }

  async reset(): Promise<void> {
    const entryKeys = await this.scanForKeys(`${this.indexName}:entry:*`, 10000);
    
    for (const key of entryKeys) {
      await this.redis.del(key);
    }

    const userIndexKeys = await this.scanForKeys(`${this.indexName}:user:*`, 1000);
    for (const key of userIndexKeys) {
      await this.redis.del(key);
    }

    console.log(`[RedisVectorStore] Reset index: ${this.indexName}`);
  }

  private buildKey(entryId: string): string {
    return `${this.indexName}:entry:${entryId}`;
  }

  private async scanForKeys(pattern: string, maxCount: number = 1000): Promise<string[]> {
    const keys: string[] = [];
    let cursor = 0;
    const batchSize = 100;

    do {
      const result = await this.redis.scan(cursor, {
        match: pattern,
        count: batchSize,
      });

      cursor = parseInt(result[0] as string, 10);
      const batchKeys = result[1] as string[];

      for (const key of batchKeys) {
        if (key.startsWith(`${this.indexName}:entry:`)) {
          keys.push(key.replace(`${this.indexName}:entry:`, ""));
        }
      }

      if (keys.length >= maxCount) break;
    } while (cursor !== 0);

    return keys.slice(0, maxCount);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
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

// ============================================================================
// FACTORY
// Create vector store with appropriate implementation
// ============================================================================

export interface VectorStoreOptions {
  /** Use Upstash Vector (production) */
  useUpstashVector?: boolean;
  /** Upstash Vector token */
  upstashVectorToken?: string;
  /** Upstash Vector URL */
  upstashVectorUrl?: string;
  /** Redis client (for fallback) */
  redis?: Redis;
  /** Index configuration */
  indexConfig?: Partial<VectorIndexConfig>;
}

export function createVectorStore(options: VectorStoreOptions): VectorStore {
  const indexConfig: VectorIndexConfig = {
    indexName: "semantic_memory",
    dimensions: 384,
    metric: "cosine",
    clusters: 16,
    capacity: 100000,
    ...options.indexConfig,
  };

  // Use Upstash Vector if configured
  if (options.useUpstashVector && options.upstashVectorToken) {
    console.log("[VectorStore] Using Upstash Vector (production mode)");
    return new UpstashVectorStore({
      ...indexConfig,
      upstashToken: options.upstashVectorToken,
      upstashUrl: options.upstashVectorUrl,
    });
  }

  // Fallback to Redis brute-force
  if (options.redis) {
    console.log("[VectorStore] Using Redis Vector Store (development/legacy mode)");
    console.warn(
      "[VectorStore] WARNING: Brute-force similarity search is O(N). " +
      "For production scale (>10k vectors), migrate to Upstash Vector."
    );
    return new RedisVectorStore({
      ...indexConfig,
      redis: options.redis,
    });
  }

  throw new Error(
    "VectorStore: Either 'useUpstashVector' with token or 'redis' client must be provided"
  );
}
