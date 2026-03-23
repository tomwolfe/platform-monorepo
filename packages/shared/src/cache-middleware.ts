/**
 * Request Caching Middleware
 *
 * Provides intelligent caching for API responses with:
 * - Automatic cache key generation
 * - Tag-based invalidation
 * - TTL management
 * - Cache warming
 *
 * Usage:
 * ```typescript
 * import { withCache, invalidateCacheByTag } from '@repo/shared';
 *
 * // Cache availability checks
 * export const GET = withCache(
 *   async (req) => {
 *     // Expensive query
 *     return Response.json({ available: true });
 *   },
 *   {
 *     ttl: 300, // 5 minutes
 *     tags: ['availability', 'restaurant-123'],
 *   }
 * );
 *
 * // Invalidate when data changes
 * await invalidateCacheByTag('restaurant-123');
 * ```
 *
 * @see Phase 2.1: Caching Strategy
 */

import { getRedisClient, ServiceNamespace } from './redis';
import { Logger } from './logger';

// ============================================================================
// TYPES
// ============================================================================

interface CacheOptions {
  /** Cache TTL in seconds */
  ttl: number;
  /** Cache tags for invalidation */
  tags?: string[];
  /** Cache key prefix */
  keyPrefix?: string;
  /** Skip cache for certain requests */
  skip?: (req: Request) => boolean;
  /** Custom cache key generator */
  generateKey?: (req: Request) => string;
  /** Only cache successful responses */
  onlySuccess?: boolean;
  /** Logger instance */
  logger?: Logger;
}

interface CacheConfig {
  /** Enable caching */
  enabled: boolean;
  /** Default TTL in seconds */
  defaultTTL: number;
  /** Maximum cache size per key (for LRU) */
  maxSize?: number;
  /** Enable cache warming */
  enableWarming?: boolean;
  /** Enable cache metrics */
  enableMetrics?: boolean;
}

interface CacheMetrics {
  /** Total cache hits */
  hits: number;
  /** Total cache misses */
  misses: number;
  /** Total cache sets */
  sets: number;
  /** Total cache invalidations */
  invalidations: number;
  /** Cache hit rate (0-1) */
  hitRate: number;
}

// ============================================================================
// CACHE CLIENT
// ============================================================================

/**
 * Get cache client (Redis)
 */
function getCacheClient() {
  return getRedisClient(ServiceNamespace.CACHE);
}

/**
 * Generate cache key from request
 */
function generateCacheKey(req: Request, prefix?: string): string {
  const url = new URL(req.url);
  const path = url.pathname;
  const params = url.searchParams.toString();
  const method = req.method;

  const key = `${method}:${path}${params ? `?${params}` : ''}`;
  return prefix ? `${prefix}:${key}` : `cache:${key}`;
}

/**
 * Get cache key for tags
 */
function getTagKey(tag: string): string {
  return `cache:tag:${tag}`;
}

// ============================================================================
// CACHE MIDDLEWARE
// ============================================================================

/**
 * Create caching middleware for API routes
 *
 * @param handler - Request handler function
 * @param options - Cache options
 * @returns Wrapped handler with caching
 *
 * @example
 * ```typescript
 * export const GET = withCache(
 *   async (req) => {
 *     const availability = await checkAvailability();
 *     return Response.json(availability);
 *   },
 *   {
 *     ttl: 300,
 *     tags: ['availability'],
 *   }
 * );
 * ```
 */
function withCache<T extends (...args: any[]) => Promise<Response>>(
  handler: T,
  options: CacheOptions
) {
  const {
    ttl,
    tags = [],
    keyPrefix,
    skip,
    generateKey,
    onlySuccess = true,
    logger = new Logger({ serviceName: 'cache' }),
  } = options;

  return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    const req = args[0] as Request;

    // Check if caching should be skipped
    if (skip?.(req)) {
      logger.debug('Cache skipped', { path: req.url });
      return handler(...args);
    }

    const cacheKey = generateKey?.(req) || generateCacheKey(req, keyPrefix);
    const cache = getCacheClient();

    try {
      // Try to get from cache
      const cached = await cache.get(cacheKey);
      if (cached) {
        logger.debug('Cache hit', { key: cacheKey });
        return new Response(cached as string, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Cache': 'HIT',
            'X-Cache-Key': cacheKey,
          },
        }) as ReturnType<T>;
      }

      logger.debug('Cache miss', { key: cacheKey });

      // Execute handler
      const response = await handler(...args);

      // Cache successful responses
      if (!onlySuccess || response.status === 200) {
        const body = await response.clone().text();

        // Set cache with TTL
        await cache.setex(cacheKey, ttl, body);

        // Associate with tags
        for (const tag of tags) {
          const tagKey = getTagKey(tag);
          await cache.sadd(tagKey, cacheKey);
          await cache.expire(tagKey, ttl + 60); // Tags expire slightly later
        }

        logger.debug('Cache set', { key: cacheKey, ttl, tags });
      }

      // Add cache headers
      response.headers.set('X-Cache', 'MISS');
      response.headers.set('X-Cache-Key', cacheKey);

      return response as ReturnType<T>;
    } catch (error) {
      logger.error('Cache error', { error: error instanceof Error ? error.message : String(error) });
      // Return handler result without caching
      return handler(...args);
    }
  };
}

// ============================================================================
// CACHE INVALIDATION
// ============================================================================

/**
 * Invalidate cache by key
 *
 * @param key - Cache key to invalidate
 */
async function invalidateCache(key: string): Promise<void> {
  const cache = getCacheClient();
  await cache.del(key);
  console.log(`[Cache] Invalidated: ${key}`);
}

/**
 * Invalidate cache by tag
 *
 * @param tag - Tag to invalidate
 */
async function invalidateCacheByTag(tag: string): Promise<void> {
  const cache = getCacheClient();
  const tagKey = getTagKey(tag);

  // Get all keys with this tag
  const keys = await cache.smembers(tagKey);

  // Delete all keys
  if (keys.length > 0) {
    await cache.del(...keys);
    console.log(`[Cache] Invalidated ${keys.length} keys for tag: ${tag}`);
  }

  // Delete tag set
  await cache.del(tagKey);
}

/**
 * Invalidate cache by pattern
 *
 * @param pattern - Key pattern (e.g., 'cache:availability:*')
 */
async function invalidateCacheByPattern(pattern: string): Promise<void> {
  const cache = getCacheClient();

  // Get all keys matching pattern
  const keys = await cache.keys(pattern);

  if (keys.length > 0) {
    await cache.del(...keys);
    console.log(`[Cache] Invalidated ${keys.length} keys for pattern: ${pattern}`);
  }
}

/**
 * Invalidate cache for multiple tags
 */
async function invalidateCacheByTags(tags: string[]): Promise<void> {
  await Promise.all(tags.map(tag => invalidateCacheByTag(tag)));
}

// ============================================================================
// CACHE WARMING
// ============================================================================

interface CacheWarmConfig {
  /** URLs to warm */
  urls: string[];
  /** Interval in seconds */
  intervalSeconds: number;
  /** Cache options */
  cacheOptions: Omit<CacheOptions, 'skip' | 'generateKey'>;
}

/**
 * Warm cache for specified URLs
 *
 * @param configs - Cache warm configurations
 */
async function warmCache(configs: CacheWarmConfig[]): Promise<void> {
  const logger = new Logger({ serviceName: 'cache-warming' });

  for (const config of configs) {
    const { urls, cacheOptions } = config;

    for (const url of urls) {
      try {
        // Create mock request
        const req = new Request(url, { method: 'GET' });

        // Generate cache key
        const cacheKey = generateCacheKey(req, cacheOptions.keyPrefix);
        const cache = getCacheClient();

        // Check if already cached
        const cached = await cache.get(cacheKey);
        if (cached) {
          logger.debug('Already cached', { url, key: cacheKey });
          continue;
        }

        // Fetch and cache
        const response = await fetch(url);
        if (response.ok) {
          const body = await response.text();
          await cache.setex(cacheKey, cacheOptions.ttl, body);

          // Associate with tags
          for (const tag of cacheOptions.tags || []) {
            const tagKey = getTagKey(tag);
            await cache.sadd(tagKey, cacheKey);
            await cache.expire(tagKey, cacheOptions.ttl + 60);
          }

          logger.info('Cache warmed', { url, key: cacheKey });
        }
      } catch (error) {
        logger.error('Cache warming failed', { url, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

/**
 * Start periodic cache warming
 */
function startCacheWarming(configs: CacheWarmConfig[]): () => void {
  // Warm immediately
  warmCache(configs);

  // Set up intervals
  const intervals = configs.map(config => {
    return setInterval(() => {
      warmCache([config]);
    }, config.intervalSeconds * 1000);
  });

  // Return cleanup function
  return () => {
    intervals.forEach(clearInterval);
  };
}

// ============================================================================
// CACHE METRICS
// ============================================================================

/**
 * Get cache metrics
 */
async function getCacheMetrics(): Promise<CacheMetrics> {
  const cache = getCacheClient();
  const logger = new Logger({ serviceName: 'cache-metrics' });

  // Get info stats
  const info = await cache.info('stats');

  // Parse Redis info
  const stats: Record<string, string> = {};
  info.split('\n').forEach(line => {
    const [key, value] = line.trim().split(':');
    if (key && value) {
      stats[key] = value;
    }
  });

  const hits = parseInt(stats.keyspace_hits || '0', 10);
  const misses = parseInt(stats.keyspace_misses || '0', 10);
  const total = hits + misses;

  return {
    hits,
    misses,
    sets: parseInt(stats.total_commands_processed || '0', 10),
    invalidations: parseInt(stats.expired_keys || '0', 10),
    hitRate: total > 0 ? hits / total : 0,
  };
}

/**
 * Get cache size for a pattern
 */
async function getCacheSize(pattern: string = 'cache:*'): Promise<number> {
  const cache = getCacheClient();
  const keys = await cache.keys(pattern);
  return keys.length;
}

/**
 * Get memory usage
 */
async function getCacheMemoryUsage(): Promise<{
  usedMemory: number;
  usedMemoryHuman: string;
  peakMemory: number;
  peakMemoryHuman: string;
}> {
  const cache = getCacheClient();
  const info = await cache.info('memory');

  const stats: Record<string, string> = {};
  info.split('\n').forEach(line => {
    const [key, value] = line.trim().split(':');
    if (key && value) {
      stats[key] = value;
    }
  });

  return {
    usedMemory: parseInt(stats.used_memory || '0', 10),
    usedMemoryHuman: stats.used_memory_human || 'unknown',
    peakMemory: parseInt(stats.used_memory_peak || '0', 10),
    peakMemoryHuman: stats.used_memory_peak_human || 'unknown',
  };
}

// ============================================================================
// CACHE HELPER HOOKS (For React/Next.js)
// ============================================================================

/**
 * Cached fetch hook for client components
 *
 * Note: This is a server-side utility, not a React hook.
 * For client-side caching, use React Query or SWR.
 */
async function cachedFetch<T>(
  url: string,
  options: {
    ttl?: number;
    tags?: string[];
    revalidateOnFocus?: boolean;
  } = {}
): Promise<{ data: T | null; error: Error | null; fromCache: boolean }> {
  const cache = getCacheClient();
  const cacheKey = `fetch:${url}`;

  try {
    // Try cache first
    const cached = await cache.get(cacheKey);
    if (cached) {
      return { data: JSON.parse(cached as string), error: null, fromCache: true };
    }

    // Fetch from network
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    // Cache result
    const ttl = options.ttl || 300;
    await cache.setex(cacheKey, ttl, JSON.stringify(data));

    // Associate with tags
    if (options.tags) {
      for (const tag of options.tags) {
        const tagKey = getTagKey(tag);
        await cache.sadd(tagKey, cacheKey);
        await cache.expire(tagKey, ttl + 60);
      }
    }

    return { data, error: null, fromCache: false };
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error : new Error(String(error)),
      fromCache: false,
    };
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  CacheOptions,
  CacheConfig,
  CacheMetrics,
  withCache,
  invalidateCache,
  invalidateCacheByTag,
  invalidateCacheByPattern,
  invalidateCacheByTags,
  warmCache,
  startCacheWarming,
  getCacheMetrics,
  getCacheSize,
  getCacheMemoryUsage,
  cachedFetch,
  generateCacheKey,
  getTagKey,
};
