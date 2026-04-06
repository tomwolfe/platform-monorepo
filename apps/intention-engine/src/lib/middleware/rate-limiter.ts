/**
 * User-Level Rate Limiting Middleware
 *
 * Implements token bucket rate limiting keyed by user identity (clerkId).
 * Prevents a single compromised account from draining LLM quota.
 *
 * Features:
 * - Token bucket algorithm for smooth rate limiting
 * - Per-user limits (not IP-based)
 * - Redis-backed for distributed deployments
 * - Configurable limits per endpoint type
 *
 * SERVERLESS COMPATIBILITY:
 * All rate limiting state is stored in Redis to support serverless environments (Vercel).
 * Local in-memory buckets have been removed to prevent split-brain rate limiting
 * in multi-instance deployments.
 *
 * Architecture:
 * - Redis INCR with EX for atomic rate limiting
 * - Sliding window for burst handling
 * - No local fallback to ensure consistent rate limiting across all instances
 */

import { Redis } from "@upstash/redis";
import { LRUCache } from "lru-cache";

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface RateLimitConfig {
  /** Maximum requests per window */
  maxRequests: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** Burst allowance (extra requests for short bursts) */
  burstAllowance: number;
  /** Rate limit key prefix */
  keyPrefix: string;
}

export interface EndpointRateLimitConfig {
  /** Rate limit for chat/intent endpoints */
  chat: RateLimitConfig;
  /** Rate limit for execution endpoints */
  execute: RateLimitConfig;
  /** Rate limit for webhook endpoints */
  webhook: RateLimitConfig;
  /** Rate limit for API endpoints (general) */
  api: RateLimitConfig;
  /** Rate limit for cache warming endpoints */
  cache: RateLimitConfig;
}

// Default configurations
export const DEFAULT_LIMITS: EndpointRateLimitConfig = {
  chat: {
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "60"),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
    burstAllowance: 10,
    keyPrefix: "ratelimit:chat:",
  },
  execute: {
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "30"),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
    burstAllowance: 5,
    keyPrefix: "ratelimit:execute:",
  },
  webhook: {
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100"),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
    burstAllowance: 20,
    keyPrefix: "ratelimit:webhook:",
  },
  api: {
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "100"),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
    burstAllowance: 20,
    keyPrefix: "ratelimit:api:",
  },
  cache: {
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || "200"),
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000"),
    burstAllowance: 50,
    keyPrefix: "ratelimit:cache:",
  },
};

// ============================================================================
// RATE LIMIT RESULT
// ============================================================================

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Current token count */
  remaining: number;
  /** Time until window resets (ms) */
  resetInMs: number;
  /** Retry-After header value (seconds) */
  retryAfter?: number;
  /** Rate limit info headers */
  headers: {
    "X-RateLimit-Limit": string;
    "X-RateLimit-Remaining": string;
    "X-RateLimit-Reset": string;
    "X-RateLimit-Degraded"?: string;
    "Retry-After"?: string;
  };
  /** User identifier */
  userId: string;
  /** Endpoint type */
  endpointType: keyof EndpointRateLimitConfig;
}

// ============================================================================
// RATE LIMITER SERVICE
// ============================================================================

export class RateLimiterService {
  private static redis: Redis | null = null;
  private static lruCache: LRUCache<string, { count: number; resetAt: number }> | null = null;
  private config: EndpointRateLimitConfig;

  constructor(config?: Partial<EndpointRateLimitConfig>) {
    this.config = { ...DEFAULT_LIMITS, ...config };
  }

  static setRedis(redisClient: Redis | null) {
    this.redis = redisClient;
  }

  /**
   * Get or create the in-memory LRU cache for degraded mode fallback.
   * Max 1000 entries with 5-minute TTL to prevent memory leaks.
   */
  private static getLruCache(): LRUCache<string, { count: number; resetAt: number }> {
    if (!this.lruCache) {
      this.lruCache = new LRUCache({ max: 1000, ttl: 5 * 60 * 1000 });
    }
    return this.lruCache;
  }

  async checkRateLimit(
    userId: string,
    endpointType: keyof EndpointRateLimitConfig = "api"
  ): Promise<RateLimitResult> {
    const endpointConfig = this.config[endpointType];

    // Use Redis for rate limiting, with LRU cache fallback if Redis fails
    try {
      return await this.checkRateLimitRedis(userId, endpointType);
    } catch (error) {
      console.error("[RateLimiter] Redis error, falling back to LRU cache:", error);
      // Fail-degraded: Use in-memory LRU cache to preserve availability
      return this.checkRateLimitLRU(userId, endpointType);
    }
  }

  /**
   * In-memory LRU cache fallback when Redis is unavailable.
   * Provides basic rate limiting to protect against abuse while Redis is down.
   * Adds a degradation header to signal reduced security posture.
   */
  checkRateLimitLRU(
    userId: string,
    endpointType: keyof EndpointRateLimitConfig
  ): RateLimitResult {
    const endpointConfig = this.config[endpointType];
    const lru = RateLimiterService.getLruCache();
    const redisKey = `${endpointConfig.keyPrefix}${userId}`;
    const now = Date.now();

    const existing = lru.get(redisKey);
    let currentCount = 1;
    let resetAt = now + endpointConfig.windowMs;

    if (existing && existing.resetAt > now) {
      // Window still active, increment count
      currentCount = existing.count + 1;
      resetAt = existing.resetAt;
    }

    lru.set(redisKey, { count: currentCount, resetAt });

    const maxRequests = endpointConfig.maxRequests + endpointConfig.burstAllowance;
    const remaining = Math.max(0, maxRequests - currentCount);
    const allowed = currentCount <= maxRequests;

    return {
      allowed,
      remaining,
      resetInMs: resetAt - now,
      retryAfter: allowed ? undefined : Math.ceil((resetAt - now) / 1000),
      headers: {
        "X-RateLimit-Limit": maxRequests.toString(),
        "X-RateLimit-Remaining": remaining.toString(),
        "X-RateLimit-Reset": resetAt.toString(),
        "X-RateLimit-Degraded": "true", // Signal that rate limiting is in fallback mode
        ...(allowed ? {} : { "Retry-After": Math.ceil((resetAt - now) / 1000).toString() }),
      },
      userId,
      endpointType,
    };
  }

  private async checkRateLimitRedis(
    userId: string,
    endpointType: keyof EndpointRateLimitConfig
  ): Promise<RateLimitResult> {
    const endpointConfig = this.config[endpointType];
    const redisKey = `${endpointConfig.keyPrefix}${userId}`;
    const now = Date.now();

    // Use atomic INCR with conditional EXPIRE to prevent infinite lockout.
    // Only set TTL when count is exactly 1 (first request in a new window).
    // This avoids resetting the TTL on every request, which would lock users
    // out indefinitely if they continuously retry after exceeding the limit.
    const currentCount = await RateLimiterService.redis!.incr(redisKey);
    if (currentCount === 1) {
      await RateLimiterService.redis!.expire(redisKey, Math.ceil(endpointConfig.windowMs / 1000));
    }
    const maxRequests = endpointConfig.maxRequests + endpointConfig.burstAllowance;
    const remaining = Math.max(0, maxRequests - currentCount);
    const resetInMs = endpointConfig.windowMs;

    const allowed = currentCount <= maxRequests;

    const result: RateLimitResult = {
      allowed,
      remaining,
      resetInMs,
      retryAfter: allowed ? undefined : Math.ceil(resetInMs / 1000),
      headers: {
        "X-RateLimit-Limit": maxRequests.toString(),
        "X-RateLimit-Remaining": remaining.toString(),
        "X-RateLimit-Reset": (now + resetInMs).toString(),
        ...(allowed ? {} : { "Retry-After": Math.ceil(resetInMs / 1000).toString() }),
      },
      userId,
      endpointType,
    };

    return result;
  }

  /**
   * Get current rate limit status for a user (without consuming)
   */
  async getStatus(
    userId: string,
    endpointType: keyof EndpointRateLimitConfig = "api"
  ): Promise<{
    remaining: number;
    limit: number;
    resetInMs: number;
  }> {
    const endpointConfig = this.config[endpointType];
    const redisKey = `${endpointConfig.keyPrefix}${userId}`;
    const currentCount = await RateLimiterService.redis?.get<number>(redisKey);

    const maxRequests = endpointConfig.maxRequests + endpointConfig.burstAllowance;
    return {
      remaining: currentCount !== null ? Math.max(0, maxRequests - currentCount) : maxRequests,
      limit: maxRequests,
      resetInMs: endpointConfig.windowMs,
    };
  }

  /**
   * Reset rate limit for a user
   */
  async reset(userId: string, endpointType?: keyof EndpointRateLimitConfig): Promise<void> {
    if (endpointType) {
      const endpointConfig = this.config[endpointType];
      const redisKey = `${endpointConfig.keyPrefix}${userId}`;
      await RateLimiterService.redis?.del(redisKey);
    } else {
      // Reset all endpoints for user
      for (const type of Object.keys(this.config) as Array<keyof EndpointRateLimitConfig>) {
        await this.reset(userId, type);
      }
    }
  }
}

// ============================================================================
// MIDDLEWARE WRAPPER
// ============================================================================

export interface RateLimitMiddlewareResult {
  allowed: boolean;
  result: RateLimitResult;
  error?: string;
}

export async function rateLimitMiddleware(
  userId: string,
  endpointType: keyof EndpointRateLimitConfig = "api",
  config?: Partial<EndpointRateLimitConfig>
): Promise<RateLimitMiddlewareResult> {
  try {
    const limiter = new RateLimiterService(config);
    const result = await limiter.checkRateLimit(userId, endpointType);

    if (!result.allowed) {
      return {
        allowed: false,
        result,
        error: `Rate limit exceeded. Try again in ${Math.ceil(result.resetInMs / 1000)} seconds.`,
      };
    }

    return {
      allowed: true,
      result,
    };
  } catch (error) {
    console.error("[RateLimiter] Middleware error:", error);

    // DEGRADED MODE: Fall back to in-memory LRU cache when Redis is unavailable.
    // This preserves security (rate limiting still works per-instance) while
    // protecting availability (requests aren't blindly blocked).
    try {
      const limiter = new RateLimiterService(config);
      const result = limiter.checkRateLimitLRU(userId, endpointType);

      if (!result.allowed) {
        return {
          allowed: false,
          result,
          error: `Rate limit exceeded (degraded mode). Try again in ${Math.ceil(result.resetInMs / 1000)} seconds.`,
        };
      }

      return {
        allowed: true,
        result,
      };
    } catch (lruError) {
      // Absolute last resort - this should never happen
      console.error("[RateLimiter] LRU cache fallback also failed:", lruError);

      // Fail-open for non-critical endpoints, fail-closed for critical ones
      const isCriticalEndpoint = endpointType !== "cache";

      if (isCriticalEndpoint) {
        return {
          allowed: false,
          result: {
            allowed: false,
            remaining: 0,
            resetInMs: 0,
            headers: {
              "X-RateLimit-Limit": "0",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": "0",
              "X-RateLimit-Degraded": "true",
              "Retry-After": "60",
            },
            userId,
            endpointType,
          },
          error: "Rate limiter completely unavailable - service temporarily blocked (503)",
        };
      }

      // Fail-open for cache endpoints (availability over security)
      return {
        allowed: true,
        result: {
          allowed: true,
          remaining: 0,
          resetInMs: 0,
          headers: {
            "X-RateLimit-Limit": "0",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": "0",
            "X-RateLimit-Degraded": "true",
          },
          userId,
          endpointType,
        },
        error: "Rate limiter completely unavailable",
      };
    }
  }
}

// ============================================================================
// EXPRESS/NEXT.JS MIDDLEWARE
// ============================================================================

/**
 * Create rate limit middleware for Next.js API routes
 */
export function createRateLimitMiddleware(
  endpointType: keyof EndpointRateLimitConfig = "api",
  getUserId?: (request: Request) => string
) {
  return async function rateLimit(request: Request): Promise<{
    allowed: boolean;
    headers?: Record<string, string>;
    error?: string;
  }> {
    // Extract user ID
    const clerkId = request.headers.get("x-clerk-id");
    const userIp = request.headers.get("x-forwarded-for") || "anonymous";
    const userId = getUserId ? getUserId(request) : (clerkId || userIp);
    
    // Check rate limit
    const result = await rateLimitMiddleware(userId, endpointType);
    
    if (!result.allowed) {
      return {
        allowed: false,
        headers: result.result.headers,
        error: result.error,
      };
    }
    
    return {
      allowed: true,
      headers: result.result.headers,
    };
  };
}

// ============================================================================
// CLEANUP
// Periodic cleanup of local buckets
// Note: Cleanup is handled internally by RateLimiterService
// ============================================================================
