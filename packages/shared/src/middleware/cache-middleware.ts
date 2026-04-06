/**
 * Request Caching Middleware
 * 
 * Phase 2.2: Performance & Reliability
 * 
 * Provides transparent caching for GET requests with:
 * - Automatic cache key generation
 * - Configurable TTL per endpoint
 * - Cache invalidation helpers
 * - Cache hit/miss metrics
 * 
 * @package @repo/shared
 * @since 1.0.0
 */

import { CacheClient, getSharedCache } from '../infrastructure/cache';

// ============================================================================
// STABLE STRINGIFICATION
// Deterministic JSON stringification for consistent cache keys
// ============================================================================

function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `"${k}":${stableStringify(obj[k])}`).join(',')}}`;
}

// ============================================================================
// TYPES
// ============================================================================

export interface CacheOptions {
  /** Cache TTL in seconds (default: 300 = 5 minutes) */
  ttlSeconds?: number;
  /** Custom cache key (auto-generated if not provided) */
  key?: string;
  /** Cache namespace (default: 'shared') */
  namespace?: string;
  /** Skip cache conditionally */
  skip?: boolean;
  /** Tags for cache invalidation */
  tags?: string[];
}

export interface CacheMetrics {
  /** Cache hits */
  hits: number;
  /** Cache misses */
  misses: number;
  /** Cache errors */
  errors: number;
  /** Hit rate (0-1) */
  hitRate: number;
}

// ============================================================================
// CACHE METRICS TRACKING
// ============================================================================

let cacheMetrics: CacheMetrics = {
  hits: 0,
  misses: 0,
  errors: 0,
  hitRate: 0,
};

/**
 * Get cache metrics
 */
export function getCacheMetrics(): CacheMetrics {
  return { ...cacheMetrics };
}

/**
 * Reset cache metrics (for testing)
 */
export function resetCacheMetrics(): void {
  cacheMetrics = {
    hits: 0,
    misses: 0,
    errors: 0,
    hitRate: 0,
  };
}

/**
 * Update hit rate calculation
 */
function updateHitRate(): void {
  const total = cacheMetrics.hits + cacheMetrics.misses;
  cacheMetrics.hitRate = total > 0 ? cacheMetrics.hits / total : 0;
}

// ============================================================================
// CACHE KEY GENERATION
// ============================================================================

/**
 * Generate cache key from request
 * 
 * @param path - Request path
 * @param params - Query parameters
 * @returns Cache key string
 */
export function generateCacheKey(path: string, params?: Record<string, string | undefined>): string {
  const sortedParams = params
    ? Object.entries(params)
        .filter(([_, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&')
    : '';
  
  const key = sortedParams ? `${path}?${sortedParams}` : path;
  return `cache:${key}`;
}

// ============================================================================
// WITH CACHE DECORATOR
// ============================================================================

/**
 * Wrap a function with caching
 * 
 * @example
 * ```typescript
 * const getAvailability = withCache(
 *   async (restaurantId: string, date: string) => {
 *     // Expensive database query
 *     return await db.query...;
 *   },
 *   { ttlSeconds: 300 }
 * );
 * ```
 * 
 * @param fn - Function to cache
 * @param options - Cache options
 * @returns Cached function
 */
export function withCache<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options?: CacheOptions
): T {
  const ttlSeconds = options?.ttlSeconds || 300; // 5 minutes default
  const cache = getSharedCache();
  
  return (async (...args: any[]) => {
    // Skip cache if requested
    if (options?.skip) {
      return await fn(...args);
    }
    
    // Generate cache key from arguments
    const cacheKey = options?.key || generateCacheKey(
      fn.name || 'anonymous',
      { args: stableStringify(args) }
    );
    
    try {
      // Try to get from cache
      const cached = await cache.get<ReturnType<T>>(cacheKey);
      if (cached !== null) {
        cacheMetrics.hits++;
        updateHitRate();
        console.log(`[Cache] HIT: ${cacheKey}`);
        return cached;
      }
      
      // Cache miss - execute function
      cacheMetrics.misses++;
      updateHitRate();
      console.log(`[Cache] MISS: ${cacheKey}`);
      
      const result = await fn(...args);
      
      // Store in cache
      await cache.set(cacheKey, result, { ttlSeconds });
      
      // Store tag index for invalidation
      if (options?.tags) {
        for (const tag of options.tags) {
          const tagKey = `cache:tag:${tag}`;
          await cache.getRawClient().sadd(tagKey, cacheKey);
          await cache.getRawClient().expire(tagKey, ttlSeconds + 60);
        }
      }
      
      return result;
    } catch (error) {
      cacheMetrics.errors++;
      console.error(`[Cache] Error for key ${cacheKey}:`, error);
      // On error, execute function without caching
      return await fn(...args);
    }
  }) as T;
}

// ============================================================================
// CACHE INVALIDATION
// ============================================================================

/**
 * Invalidate cached entries by key
 * 
 * @param key - Cache key or pattern
 * @param cache - Cache client (optional, uses shared cache)
 */
export async function invalidateCache(
  key: string,
  cache?: CacheClient
): Promise<boolean> {
  const cacheClient = cache || getSharedCache();
  return await cacheClient.delete(key);
}

/**
 * Invalidate cached entries by tag
 * 
 * @param tag - Cache tag
 * @param cache - Cache client (optional, uses shared cache)
 */
export async function invalidateCacheByTag(
  tag: string,
  cache?: CacheClient
): Promise<number> {
  const cacheClient = cache || getSharedCache();
  const tagKey = `cache:tag:${tag}`;
  
  try {
    // Get all keys with this tag
    const keys = await cacheClient.getRawClient().smembers(tagKey);
    
    if (keys.length === 0) {
      return 0;
    }
    
    // Delete all tagged keys
    await cacheClient.getRawClient().del(...keys);
    
    // Delete tag set
    await cacheClient.getRawClient().del(tagKey);
    
    console.log(`[Cache] Invalidated ${keys.length} entries for tag: ${tag}`);
    return keys.length;
  } catch (error) {
    console.error(`[Cache] Failed to invalidate tag ${tag}:`, error);
    return 0;
  }
}

/**
 * Invalidate cached entries by pattern
 * 
 * @param pattern - Cache key pattern
 * @param cache - Cache client (optional, uses shared cache)
 */
export async function invalidateCacheByPattern(
  pattern: string,
  cache?: CacheClient
): Promise<number> {
  const cacheClient = cache || getSharedCache();
  const keys = await cacheClient.keys(pattern);
  
  if (keys.length === 0) {
    return 0;
  }
  
  for (const key of keys) {
    await cacheClient.delete(key);
  }
  
  console.log(`[Cache] Invalidated ${keys.length} entries for pattern: ${pattern}`);
  return keys.length;
}

// ============================================================================
// NEXT.JS API ROUTE MIDDLEWARE
// ============================================================================

/**
 * Cache middleware for Next.js API routes
 * 
 * @example
 * ```typescript
 * import { withCacheMiddleware } from '@repo/shared/cache-middleware';
 * 
 * export const GET = withCacheMiddleware(
 *   async (req: NextRequest) => {
 *     // Handler logic
 *     return NextResponse.json({ data: '...' });
 *   },
 *   { ttlSeconds: 300 }
 * );
 * ```
 */
export function withCacheMiddleware<T extends (...args: any[]) => Promise<Response>>(
  handler: T,
  options?: CacheOptions
): T {
  const ttlSeconds = options?.ttlSeconds || 300;
  const cache = getSharedCache();
  
  return (async (...args: any[]) => {
    const req = args[0] as Request;
    
    // Only cache GET requests
    if (req.method !== 'GET') {
      return await handler(...args);
    }
    
    // Skip cache if requested
    if (options?.skip || req.headers.get('cache-control') === 'no-cache') {
      return await handler(...args);
    }
    
    // Generate cache key from URL
    const url = new URL(req.url);
    const path = url.pathname;
    const params = Object.fromEntries(url.searchParams);
    const cacheKey = options?.key || generateCacheKey(path, params);
    
    try {
      // Try to get from cache
      const cached = await cache.get<{ body: unknown; headers?: Record<string, string> }>(cacheKey);
      
      if (cached !== null) {
        cacheMetrics.hits++;
        updateHitRate();
        console.log(`[Cache] HIT: ${cacheKey}`);
        
        return new Response(JSON.stringify(cached.body), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Cache': 'HIT',
            'Age': Math.floor(
              (Date.now() - new Date(cached.headers?.['cached-at'] || Date.now()).getTime()) / 1000
            ).toString(),
            ...cached.headers,
          },
        });
      }
      
      // Cache miss - execute handler
      cacheMetrics.misses++;
      updateHitRate();
      console.log(`[Cache] MISS: ${cacheKey}`);
      
      const response = await handler(...args);
      
      // Clone response to read body
      const clonedResponse = response.clone();
      const body = await clonedResponse.json().catch(() => null);
      
      // Cache successful responses only
      if (response.status === 200 && body !== null) {
        await cache.set(cacheKey, {
          body,
          headers: {
            'cached-at': new Date().toISOString(),
          },
        }, { ttlSeconds });
      }
      
      // Add cache header to response
      const newResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
      
      newResponse.headers.set('X-Cache', 'MISS');
      
      return newResponse;
    } catch (error) {
      cacheMetrics.errors++;
      console.error(`[Cache] Error for key ${cacheKey}:`, error);
      
      // On error, execute handler without caching
      return await handler(...args);
    }
  }) as T;
}
