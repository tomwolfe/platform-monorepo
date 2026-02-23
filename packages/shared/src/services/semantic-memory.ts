/**
 * Vector Store for Semantic Memory
 *
 * Enables similarity-based retrieval of historical interactions for
 * true conversational continuity and context-aware intent inference.
 *
 * Architecture:
 * - Uses Vector Store abstraction (packages/shared/src/services/vector-store.ts)
 * - Supports Upstash Vector (production, O(log N) search)
 * - Falls back to Redis brute-force (development, O(N) search)
 * - For >10k vectors, migrate to Upstash Vector for production performance
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { z } from "zod";
import { Redis } from "@upstash/redis";
import {
  createVectorStore,
  type VectorStore,
  type VectorEntry,
  type VectorSearchResult,
  type VectorSearchQuery,
} from "./vector-store";

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
// SEMANTIC VECTOR STORE (WRAPPER)
// Wraps the VectorStore abstraction with semantic memory-specific logic
// ============================================================================

export interface SemanticVectorStoreConfig {
  vectorStore: VectorStore;
  embeddingService: EmbeddingService;
  indexName?: string;
  ttlSeconds?: number;
}

export class SemanticVectorStore {
  private vectorStore: VectorStore;
  private embeddingService: EmbeddingService;
  private indexName: string;
  private ttlSeconds?: number;

  constructor(config: SemanticVectorStoreConfig) {
    this.vectorStore = config.vectorStore;
    this.embeddingService = config.embeddingService;
    this.indexName = config.indexName || "semantic_memory";
    this.ttlSeconds = config.ttlSeconds;
  }

  /**
   * Add a new memory entry to the vector store
   * 
   * PERFORMANCE: Upstash Vector provides O(log N) insertion and search
   * vs O(N) brute-force in Redis fallback
   */
  async addEntry(entry: Omit<SemanticMemoryEntry, "embedding">): Promise<SemanticMemoryEntry> {
    // Generate embedding
    const textForEmbedding = this.buildEmbeddingText(entry);
    const embedding = await this.embeddingService.generateEmbedding(textForEmbedding);

    const completeEntry: SemanticMemoryEntry = {
      ...entry,
      embedding,
    };

    // Add to vector store
    await this.vectorStore.addVector({
      userId: entry.userId,
      intentType: entry.intentType,
      rawText: entry.rawText,
      parameters: entry.parameters,
      embedding,
      timestamp: entry.timestamp,
      executionId: entry.executionId,
      restaurantId: entry.restaurantId,
      restaurantSlug: entry.restaurantSlug,
      restaurantName: entry.restaurantName,
      outcome: entry.outcome,
      metadata: entry.metadata,
    });

    console.log(
      `[VectorStore] Added entry ${entry.id} for user ${entry.userId} ` +
      `(using ${this.vectorStore.constructor.name})`
    );
    return completeEntry;
  }

  /**
   * Search for similar memories
   * 
   * PERFORMANCE:
   * - Upstash Vector: O(log N) indexed search
   * - Redis fallback: O(N) brute-force (limited to 500 candidates)
   */
  async search(query: SemanticSearchQuery): Promise<SemanticSearchResult[]> {
    let queryEmbedding = query.queryEmbedding;

    // Generate embedding if not provided
    if (!queryEmbedding) {
      queryEmbedding = await this.embeddingService.generateEmbedding(query.query);
    }

    // Build filter
    const filter: Record<string, unknown> = {};
    
    if (query.intentType) {
      filter.intentType = query.intentType;
    }
    
    if (query.restaurantId) {
      filter.restaurantId = query.restaurantId;
    }

    // Search vector store
    const vectorResults = await this.vectorStore.search({
      queryVector: queryEmbedding,
      userId: query.userId,
      limit: query.limit,
      minScore: query.minSimilarity,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
    });

    // Convert to semantic search results
    return vectorResults.map((result, index) => ({
      entry: {
        id: crypto.randomUUID(), // Vector store doesn't return full entry
        userId: result.metadata.userId as string || "unknown",
        intentType: result.metadata.intentType as string || "unknown",
        rawText: result.metadata.rawText as string || "",
        embedding: [], // Not returned from vector store
        timestamp: result.metadata.timestamp as string || new Date().toISOString(),
        outcome: result.metadata.outcome as SemanticMemoryEntry["outcome"],
        restaurantId: result.metadata.restaurantId as string | undefined,
        restaurantName: result.metadata.restaurantName as string | undefined,
        metadata: result.metadata,
      },
      similarity: result.score,
      rank: index + 1,
    }));
  }

  /**
   * Get most recent memories for a user
   * Note: This is a legacy method - vector stores don't support time-based ordering
   * Use search with userId filter instead
   */
  async getRecentMemories(userId: string, limit: number = 10): Promise<SemanticMemoryEntry[]> {
    // Use a dummy vector to get recent entries (not ideal, but maintains API compatibility)
    const dummyVector = new Array(384).fill(0);
    
    const results = await this.vectorStore.search({
      queryVector: dummyVector,
      userId,
      limit,
      minScore: 0,
    });

    return results.map(result => ({
      id: crypto.randomUUID(),
      userId: result.metadata.userId as string || userId,
      intentType: result.metadata.intentType as string || "unknown",
      rawText: result.metadata.rawText as string || "",
      embedding: [],
      timestamp: result.metadata.timestamp as string || new Date().toISOString(),
      outcome: result.metadata.outcome as SemanticMemoryEntry["outcome"],
      restaurantId: result.metadata.restaurantId as string | undefined,
      restaurantName: result.metadata.restaurantName as string | undefined,
      metadata: result.metadata,
    }));
  }

  /**
   * Delete a memory entry
   */
  async deleteEntry(entryId: string): Promise<boolean> {
    // Note: Vector store deletion is by ID, but we need to track entry IDs
    // This is a limitation - consider maintaining an entry ID -> vector ID mapping
    console.warn("[VectorStore] deleteEntry not fully supported with vector store abstraction");
    return false;
  }

  /**
   * Clear all memories for a user
   */
  async clearUserMemories(userId: string): Promise<number> {
    return await this.vectorStore.deleteByUserId(userId);
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
    const stats = await this.vectorStore.getStats();
    return {
      totalEntries: stats.totalVectors,
      uniqueUsers: stats.uniqueUsers,
      uniqueRestaurants: stats.uniqueRestaurants,
      avgEntriesPerUser: stats.uniqueUsers > 0 ? stats.totalVectors / stats.uniqueUsers : 0,
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
// Create semantic vector store with appropriate backend
// ============================================================================

export function createSemanticVectorStore(options?: {
  redis?: Redis;
  embeddingApiKey?: string;
  useMockEmbeddings?: boolean;
  indexName?: string;
  ttlSeconds?: number;
  useUpstashVector?: boolean;
}): SemanticVectorStore {
  const { getRedisClient, ServiceNamespace } = require("../redis");

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

  // Determine vector store backend
  const useUpstashVector = options?.useUpstashVector ?? !!process.env.UPSTASH_VECTOR_TOKEN;
  const upstashToken = process.env.UPSTASH_VECTOR_TOKEN;
  const upstashUrl = process.env.UPSTASH_VECTOR_URL;

  let vectorStore: VectorStore;

  if (useUpstashVector && upstashToken) {
    // Use Upstash Vector (production)
    const { createVectorStore } = require("./vector-store");
    vectorStore = createVectorStore({
      useUpstashVector: true,
      upstashVectorToken: upstashToken,
      upstashVectorUrl: upstashUrl,
      indexConfig: {
        indexName: options?.indexName || "semantic_memory",
        dimensions: 384,
        metric: "cosine",
      },
    });
    console.log("[VectorStore] Using Upstash Vector (production mode)");
  } else {
    // Fallback to Redis (development)
    const redis = options?.redis || getRedisClient(ServiceNamespace.SHARED);
    const { createVectorStore } = require("./vector-store");
    vectorStore = createVectorStore({
      redis,
      indexConfig: {
        indexName: options?.indexName || "semantic_memory",
        dimensions: 384,
        metric: "cosine",
      },
    });
    console.log("[VectorStore] Using Redis Vector Store (development mode)");
  }

  return new SemanticVectorStore({
    vectorStore,
    embeddingService,
    indexName: options?.indexName,
    ttlSeconds: options?.ttlSeconds,
  });
}
