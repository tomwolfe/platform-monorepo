/**
 * PGVector Schema for Neon Database
 *
 * Implements hybrid vector-relational search for semantic memory.
 * Keeps semantic memory (vectors) and business data (audit logs) in the same
 * ACID-compliant transaction, removing the need for secondary Outbox sync.
 *
 * Features:
 * - Cosine similarity search with indexing (ivfflat)
 * - Metadata filtering (userId, intentType, restaurantId)
 * - Combined vector + relational queries
 * - Full transactional consistency with business data
 *
 * Setup:
 * 1. Enable pgvector extension in Neon: CREATE EXTENSION IF NOT EXISTS vector;
 * 2. Run migration: pnpm db:migrate
 * 3. Use SemanticVectorStore for search/insert operations
 *
 * @package @repo/database
 * @since 1.0.0
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
  pgExtension,
  vector,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ============================================================================
// PGVECTOR EXTENSION
// Must be enabled in Neon database
// ============================================================================

// Create vector extension (run this SQL manually in Neon console or migration)
// CREATE EXTENSION IF NOT EXISTS vector;

// ============================================================================
// VECTOR DIMENSION CONFIGURATION
// ============================================================================

/**
 * Vector dimensions for different embedding models
 * Common sizes:
 * - all-MiniLM-L6-v2: 384 dimensions (default, fast, good for most cases)
 * - all-mpnet-base-v2: 768 dimensions (better quality, slower)
 * - text-embedding-ada-002: 1536 dimensions (OpenAI)
 */
export const VECTOR_DIMENSIONS = {
  MINI_LM: 384,
  MPNET: 768,
  OPENAI_ADA: 1536,
} as const;

export type VectorDimensionSize = typeof VECTOR_DIMENSIONS[keyof typeof VECTOR_DIMENSIONS];

// ============================================================================
// SEMANTIC MEMORY TABLE
// Stores vector embeddings with metadata for semantic search
// ============================================================================

/**
 * Semantic memory entry with vector embedding
 *
 * Usage:
 * ```ts
 * // Insert
 * await db.insert(semanticMemories).values({
 *   id: crypto.randomUUID(),
 *   userId: 'user-123',
 *   intentType: 'book_restaurant',
 *   rawText: 'Book a table for 2 at Italian restaurant',
 *   embedding: [0.1, 0.2, ...], // 384-dim vector
 *   parameters: { partySize: 2, cuisine: 'Italian' },
 *   timestamp: new Date().toISOString(),
 * });
 *
 * // Search with cosine similarity
 * const query = [0.1, 0.2, ...];
 * const results = await db.select({
 *   entry: semanticMemories,
 *   similarity: sql`1 - (${semanticMemories.embedding} <=> ${query})`,
 * }).orderBy(sql`similarity DESC`).limit(5);
 * ```
 */
export const semanticMemories = pgTable(
  'semantic_memories',
  {
    // Primary key
    id: uuid('id').primaryKey().defaultRandom(),

    // User identifier (for filtering and partitioning)
    userId: text('user_id').notNull(),

    // Intent type (e.g., 'book_restaurant', 'cancel_reservation')
    intentType: text('intent_type').notNull(),

    // Original raw text that was embedded
    rawText: text('raw_text').notNull(),

    // Vector embedding (384 dimensions by default)
    // Uses pgvector extension type
    embedding: vector('embedding', { dimensions: 384 }).notNull(),

    // Parameters from the intent (JSON)
    parameters: jsonb('parameters').$type<Record<string, unknown>>(),

    // Timestamp of the interaction
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),

    // Optional: Execution ID for tracing
    executionId: uuid('execution_id'),

    // Optional: Restaurant context
    restaurantId: uuid('restaurant_id'),
    restaurantSlug: text('restaurant_slug'),
    restaurantName: text('restaurant_name'),

    // Outcome of the interaction
    outcome: text('outcome', {
      enum: ['success', 'failed', 'partial', 'abandoned'],
    }),

    // Additional metadata
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),

    // Created at (auto-populated)
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      // Index for user-based filtering
      userIdIdx: index('semantic_memories_user_id_idx').on(table.userId),

      // Index for intent type filtering
      intentTypeIdx: index('semantic_memories_intent_type_idx').on(table.intentType),

      // Index for restaurant filtering
      restaurantIdIdx: index('semantic_memories_restaurant_id_idx').on(table.restaurantId),

      // Index for timestamp (time-based queries)
      timestampIdx: index('semantic_memories_timestamp_idx').on(table.timestamp),

      // Composite index for common filter combinations
      userIdIntentIdx: index('semantic_memories_user_intent_idx').on(table.userId, table.intentType),

      // Vector similarity index (ivfflat for fast approximate search)
      // This is the key index for vector search performance
      embeddingIdx: index('semantic_memories_embedding_idx')
        .using('ivfflat', table.embedding.op('vector_cosine_ops'))
        .with({ lists: 100 }), // Number of clusters - tune based on data size

      // Unique index to prevent duplicate entries
      uniqueEntry: uniqueIndex('semantic_memories_unique_idx')
        .on(table.userId, table.timestamp, table.rawText),
    };
  }
);

// ============================================================================
// VECTOR SEARCH HELPERS
// ============================================================================

/**
 * Cosine similarity function for pgvector
 * Returns similarity score between 0 and 1 (1 = identical)
 *
 * Usage:
 * ```ts
 * const query = [0.1, 0.2, ...];
 * const results = await db.select({
 *   entry: semanticMemories,
 *   similarity: cosineSimilarity(semanticMemories.embedding, query),
 * }).orderBy(sql`similarity DESC`).limit(5);
 * ```
 */
export function cosineSimilarity(
  vectorColumn: typeof semanticMemories.embedding,
  queryVector: number[]
) {
  // Cosine distance: <=> (1 - cosine similarity)
  // So we compute: 1 - (embedding <=> query)
  return sql<number>`1 - (${vectorColumn} <=> ${queryVector})`;
}

/**
 * Inner product (dot product) for pgvector
 * Useful for normalized vectors (same as cosine similarity)
 */
export function innerProduct(
  vectorColumn: typeof semanticMemories.embedding,
  queryVector: number[]
) {
  return sql<number>`(${vectorColumn} <#> ${queryVector}) * -1`;
}

/**
 * L2 distance (Euclidean distance) for pgvector
 */
export function l2Distance(
  vectorColumn: typeof semanticMemories.embedding,
  queryVector: number[]
) {
  return sql<number>`${vectorColumn} <-> ${queryVector}`;
}

/**
 * L1 distance (Manhattan distance) for pgvector
 */
export function l1Distance(
  vectorColumn: typeof semanticMemories.embedding,
  queryVector: number[]
) {
  return sql<number>`${vectorColumn} <+> ${queryVector}`;
}

// ============================================================================
// SEMANTIC MEMORY RELATIONS
// ============================================================================

export const semanticMemoriesRelations = relations(semanticMemories, ({}) => {
  // Add relations to other tables if needed
  // For now, semantic memories is standalone
  return {};
});

// ============================================================================
// VECTOR SEARCH QUERY TYPES
// ============================================================================

/**
 * Search query parameters for semantic memory
 */
export interface SemanticMemorySearchQuery {
  /** Query vector (embedding) */
  queryVector: number[];
  /** Filter by user ID */
  userId?: string;
  /** Filter by intent type */
  intentType?: string;
  /** Filter by restaurant ID */
  restaurantId?: string;
  /** Filter by outcome */
  outcome?: string;
  /** Time range filter */
  timeRange?: {
    after?: Date;
    before?: Date;
  };
  /** Maximum results to return */
  limit?: number;
  /** Minimum similarity threshold (0-1) */
  minSimilarity?: number;
  /** Distance metric to use (default: cosine) */
  distanceMetric?: 'cosine' | 'l2' | 'l1' | 'inner_product';
}

/**
 * Search result with similarity score
 */
export interface SemanticMemorySearchResult {
  id: string;
  userId: string;
  intentType: string;
  rawText: string;
  parameters?: Record<string, unknown>;
  timestamp: string;
  outcome?: string;
  restaurantId?: string;
  restaurantName?: string;
  metadata?: Record<string, unknown>;
  similarity: number;
  rank: number;
}

// ============================================================================
// MIGRATION SQL
// Run this to enable pgvector and create the table
// ============================================================================

/**
 * SQL to enable pgvector extension
 * Run once in Neon console or migration
 * 
 * Note: Execute this manually in Neon console before running migrations:
 * ```sql
 * CREATE EXTENSION IF NOT EXISTS vector;
 * ```
 */
export const ENABLE_PGVECTOR_SQL = `CREATE EXTENSION IF NOT EXISTS vector;`;

/**
 * SQL to create semantic_memories table
 * This is auto-generated by drizzle-kit migrate
 * Included here for reference only
 */
export const CREATE_SEMANTIC_MEMORIES_SQL = `
  CREATE TABLE IF NOT EXISTS semantic_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    intent_type TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    embedding vector(384) NOT NULL,
    parameters JSONB,
    timestamp TIMESTAMPTZ NOT NULL,
    execution_id UUID,
    restaurant_id UUID,
    restaurant_slug TEXT,
    restaurant_name TEXT,
    outcome TEXT CHECK (outcome IN ('success', 'failed', 'partial', 'abandoned')),
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
  );

  -- Indexes
  CREATE INDEX semantic_memories_user_id_idx ON semantic_memories(user_id);
  CREATE INDEX semantic_memories_intent_type_idx ON semantic_memories(intent_type);
  CREATE INDEX semantic_memories_restaurant_id_idx ON semantic_memories(restaurant_id);
  CREATE INDEX semantic_memories_timestamp_idx ON semantic_memories(timestamp);
  CREATE INDEX semantic_memories_user_intent_idx ON semantic_memories(user_id, intent_type);
  CREATE INDEX semantic_memories_embedding_idx ON semantic_memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  CREATE UNIQUE INDEX semantic_memories_unique_idx ON semantic_memories(user_id, timestamp, raw_text);
`;

/**
 * SQL to create a view for recent memories (optional optimization)
 */
export const CREATE_RECENT_MEMORIES_VIEW_SQL = `
  CREATE OR REPLACE VIEW recent_semantic_memories AS
  SELECT * FROM semantic_memories
  WHERE created_at > NOW() - INTERVAL '30 days'
  ORDER BY created_at DESC;
`;

// ============================================================================
// EXPORTS
// ============================================================================

export type SemanticMemory = typeof semanticMemories.$inferSelect;
export type NewSemanticMemory = typeof semanticMemories.$inferInsert;
