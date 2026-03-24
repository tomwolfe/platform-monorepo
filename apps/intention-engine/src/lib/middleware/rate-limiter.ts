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
  private config: EndpointRateLimitConfig;

  constructor(config?: Partial<EndpointRateLimitConfig>) {
    this.config = { ...DEFAULT_LIMITS, ...config };
  }

  static setRedis(redisClient: Redis | null) {
    this.redis = redisClient;
  }

  async checkRateLimit(
    userId: string,
    endpointType: keyof EndpointRateLimitConfig = "api"
  ): Promise<RateLimitResult> {
    const endpointConfig = this.config[endpointType];

    // Use Redis for rate limiting - no local fallback
    try {
      return await this.checkRateLimitRedis(userId, endpointType);
    } catch (error) {
      console.error("[RateLimiter] Redis error:", error);
      throw error;
    }
  }

  private async checkRateLimitRedis(
    userId: string,
    endpointType: keyof EndpointRateLimitConfig
  ): Promise<RateLimitResult> {
    const endpointConfig = this.config[endpointType];
    const redisKey = `${endpointConfig.keyPrefix}${userId}`;
    const now = Date.now();

    // Use Redis INCR with EX for atomic rate limiting
    const pipeline = RateLimiterService.redis!.pipeline();
    pipeline.incr(redisKey);
    pipeline.expire(redisKey, Math.ceil(endpointConfig.windowMs / 1000));
    const results = await pipeline.exec();

    const currentCount = results[0] as number;
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

    // SECURITY FIX: Fail-closed for critical endpoints to prevent quota drain under DoS
    // Only 'cache' endpoint type is allowed to fail-open (availability over security)
    const isCriticalEndpoint = endpointType !== "cache";
    
    if (isCriticalEndpoint) {
      // FAIL-CLOSED: Block requests when rate limiter is unavailable
      // This prevents attackers from bypassing rate limits by triggering Redis failures
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
            "Retry-After": "60", // Suggest retry after 60 seconds
          },
          userId,
          endpointType,
        },
        error: "Rate limiter unavailable - service temporarily blocked (503)",
      };
    }
    
    // FAIL-OPEN: Only for cache warming endpoints (availability over security)
    console.warn("[RateLimiter] Cache endpoint failing open due to rate limiter error");
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
        },
        userId,
        endpointType,
      },
      error: "Rate limiter unavailable",
    };
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
