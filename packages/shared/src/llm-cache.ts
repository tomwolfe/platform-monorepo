/**
 * LLM Response Cache
 *
 * Provides Redis-based caching for LLM responses to reduce latency and costs.
 * Uses SHA-256 hashing of prompt + tools to generate cache keys.
 *
 * @see Phase 2: LLM Cost/Latency Optimization
 */

import { createHash } from "crypto";
import { Redis } from "@upstash/redis";
import { getRedisClient, ServiceNamespace } from "./redis";

// Default TTL: 60 seconds (short to prevent stale intents during burst traffic)
export const DEFAULT_TTL_SECONDS = 60;

// Cache key prefix for LLM responses
const CACHE_KEY_PREFIX = "llm:cache:";

/**
 * Interface for cache entry structure
 */
interface LLMCacheEntry {
  /** Cached response content */
  content: string;
  /** Timestamp when entry was created (ISO 8601) */
  createdAt: string;
  /** Model ID that generated this response */
  modelId: string;
  /** Token usage from original response */
  tokenUsage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Generate SHA-256 hash for cache key from prompt components
 *
 * Creates a deterministic cache key by hashing:
 * - systemPrompt (if provided)
 * - userPrompt (required)
 * - tools (if provided, serialized to JSON)
 * - modelType (to prevent cross-model cache collisions)
 *
 * @param systemPrompt - Optional system prompt
 * @param userPrompt - User prompt (required)
 * @param tools - Optional tools array
 * @param modelType - Model type identifier
 * @returns SHA-256 hash string
 */
export function generateCacheKey(
  systemPrompt: string | undefined,
  userPrompt: string,
  tools: unknown[] | undefined,
  modelType: string,
): string {
  const hash = createHash("sha256");

  // Hash components in deterministic order
  hash.update(`system:${systemPrompt || ""}|`);
  hash.update(`user:${userPrompt}|`);

  // OPTIMIZATION: Only hash tool names and parameter structure, NOT descriptions.
  // This prevents cache busts when tool descriptions are updated (e.g., typo fixes)
  // while keeping the cache valid for identical tool signatures.
  const toolSignature = tools
    ? JSON.stringify(
        tools.map((t: any) => ({
          name: t.name,
          params: Object.keys(t.parameters?.properties || {}),
        })),
      )
    : "";
  hash.update(`tools:${toolSignature}|`);

  hash.update(`model:${modelType}`);

  return `${CACHE_KEY_PREFIX}${hash.digest("hex")}`;
}

/**
 * Get cached LLM response from Redis
 *
 * @param redisClient - Redis client instance
 * @param cacheKey - Cache key (from generateCacheKey)
 * @returns Cached entry or null if not found/expired
 */
export async function getCachedResponse(
  redisClient: Redis,
  cacheKey: string,
): Promise<LLMCacheEntry | null> {
  try {
    const cached = await redisClient.get<LLMCacheEntry>(cacheKey);

    if (!cached) {
      return null;
    }

    return cached;
  } catch (error) {
    // Cache miss due to error - continue without caching
    console.warn(
      `[LLMCache] Failed to retrieve cache for key ${cacheKey}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Store LLM response in Redis cache
 *
 * @param redisClient - Redis client instance
 * @param cacheKey - Cache key (from generateCacheKey)
 * @param entry - Cache entry to store
 * @param ttlSeconds - Time-to-live in seconds (default: 60)
 */
export async function cacheResponse(
  redisClient: Redis,
  cacheKey: string,
  entry: LLMCacheEntry,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  try {
    await redisClient.set(cacheKey, entry, { ex: ttlSeconds });
  } catch (error) {
    // Cache write failure - log warning but don't fail the request
    console.warn(
      `[LLMCache] Failed to cache response for key ${cacheKey}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Create a Redis client optimized for LLM caching
 * Uses Intention Engine namespace for isolation
 */
export function getLLMCacheClient(): Redis {
  return getRedisClient(ServiceNamespace.IE);
}

/**
 * Invalidate all cached LLM responses
 * Use with caution - typically only needed for testing or manual intervention
 */
export async function invalidateLLMCache(): Promise<void> {
  try {
    const redis = getLLMCacheClient();
    const keys = await redis.keys(`${CACHE_KEY_PREFIX}*`);

    if (keys.length > 0) {
      await redis.del(...keys);
      console.log(`[LLMCache] Invalidated ${keys.length} cache entries`);
    }
  } catch (error) {
    console.error(
      "[LLMCache] Failed to invalidate cache:",
      error instanceof Error ? error.message : error,
    );
  }
}

// Re-export types
export type { LLMCacheEntry };
