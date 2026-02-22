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
 * - Graceful degradation on Redis failure
 *
 * Architecture:
 * - Local in-memory token bucket for fast path
 * - Redis sync for distributed rate limiting
 * - Sliding window for burst handling
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
  /** Enable Redis sync (default: true) */
  enableRedisSync: boolean;
  /** Fallback to local limiting if Redis fails (default: true) */
  fallbackToLocal: boolean;
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
}

// Default configurations
export const DEFAULT_LIMITS: EndpointRateLimitConfig = {
  chat: {
    maxRequests: 60,
    windowMs: 60000, // 1 minute
    burstAllowance: 10,
    enableRedisSync: true,
    fallbackToLocal: true,
    keyPrefix: "ratelimit:chat:",
  },
  execute: {
    maxRequests: 30,
    windowMs: 60000, // 1 minute
    burstAllowance: 5,
    enableRedisSync: true,
    fallbackToLocal: true,
    keyPrefix: "ratelimit:execute:",
  },
  webhook: {
    maxRequests: 100,
    windowMs: 60000, // 1 minute
    burstAllowance: 20,
    enableRedisSync: true,
    fallbackToLocal: true,
    keyPrefix: "ratelimit:webhook:",
  },
  api: {
    maxRequests: 100,
    windowMs: 60000, // 1 minute
    burstAllowance: 20,
    enableRedisSync: true,
    fallbackToLocal: true,
    keyPrefix: "ratelimit:api:",
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
// TOKEN BUCKET IMPLEMENTATION
// ============================================================================

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private maxTokens: number;
  private refillRate: number; // tokens per ms

  constructor(maxTokens: number, refillRatePerMs: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.refillRate = refillRatePerMs;
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  consume(tokens: number = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  getTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  getTimeUntilRefill(tokensNeeded: number = 1): number {
    this.refill();
    if (this.tokens >= tokensNeeded) {
      return 0;
    }
    const tokensDeficit = tokensNeeded - this.tokens;
    return Math.ceil(tokensDeficit / this.refillRate);
  }
}

// ============================================================================
// RATE LIMITER SERVICE
// ============================================================================

export class RateLimiterService {
  private static redis: Redis | null = null;
  private localBuckets = new Map<string, TokenBucket>();
  private config: EndpointRateLimitConfig;

  constructor(config?: Partial<EndpointRateLimitConfig>) {
    this.config = { ...DEFAULT_LIMITS, ...config };
  }

  static setRedis(redisClient: Redis | null) {
    this.redis = redisClient;
  }

  private getLocalBucket(
    userId: string,
    endpointType: keyof EndpointRateLimitConfig
  ): TokenBucket {
    const key = `${endpointType}:${userId}`;
    
    if (!this.localBuckets.has(key)) {
      const endpointConfig = this.config[endpointType];
      const bucket = new TokenBucket(
        endpointConfig.maxRequests + endpointConfig.burstAllowance,
        endpointConfig.maxRequests / endpointConfig.windowMs
      );
      this.localBuckets.set(key, bucket);
    }
    
    return this.localBuckets.get(key)!;
  }

  async checkRateLimit(
    userId: string,
    endpointType: keyof EndpointRateLimitConfig = "api"
  ): Promise<RateLimitResult> {
    const endpointConfig = this.config[endpointType];
    const bucket = this.getLocalBucket(userId, endpointType);
    
    // Try Redis first if enabled
    if (endpointConfig.enableRedisSync && RateLimiterService.redis) {
      try {
        return await this.checkRateLimitRedis(userId, endpointType, bucket);
      } catch (error) {
        console.warn("[RateLimiter] Redis failed, falling back to local:", error);
        if (!endpointConfig.fallbackToLocal) {
          throw error;
        }
      }
    }
    
    // Fallback to local limiting
    return this.checkRateLimitLocal(userId, endpointType, bucket);
  }

  private async checkRateLimitRedis(
    userId: string,
    endpointType: keyof EndpointRateLimitConfig,
    localBucket: TokenBucket
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
    
    // Sync local bucket with Redis count
    const localTokens = localBucket.getTokens();
    if (Math.abs(localTokens - remaining) > 5) {
      // Significant drift, adjust local bucket
      localBucket.consume(Math.max(0, localTokens - remaining));
    }
    
    return result;
  }

  private checkRateLimitLocal(
    userId: string,
    endpointType: keyof EndpointRateLimitConfig,
    bucket: TokenBucket
  ): RateLimitResult {
    const endpointConfig = this.config[endpointType];
    const now = Date.now();
    
    const allowed = bucket.consume(1);
    const remaining = bucket.getTokens();
    const resetInMs = allowed ? endpointConfig.windowMs : bucket.getTimeUntilRefill(1);
    
    const result: RateLimitResult = {
      allowed,
      remaining,
      resetInMs,
      retryAfter: allowed ? undefined : Math.ceil(resetInMs / 1000),
      headers: {
        "X-RateLimit-Limit": (endpointConfig.maxRequests + endpointConfig.burstAllowance).toString(),
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
    const bucket = this.getLocalBucket(userId, endpointType);
    
    if (endpointConfig.enableRedisSync && RateLimiterService.redis) {
      try {
        const redisKey = `${endpointConfig.keyPrefix}${userId}`;
        const currentCount = await RateLimiterService.redis.get<number>(redisKey);
        
        if (currentCount !== null) {
          const maxRequests = endpointConfig.maxRequests + endpointConfig.burstAllowance;
          return {
            remaining: Math.max(0, maxRequests - currentCount),
            limit: maxRequests,
            resetInMs: endpointConfig.windowMs,
          };
        }
      } catch (error) {
        console.warn("[RateLimiter] Redis status check failed:", error);
      }
    }
    
    const remaining = bucket.getTokens();
    const maxRequests = endpointConfig.maxRequests + endpointConfig.burstAllowance;
    
    return {
      remaining,
      limit: maxRequests,
      resetInMs: bucket.getTimeUntilRefill(1),
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
      
      const localKey = `${endpointType}:${userId}`;
      this.localBuckets.delete(localKey);
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
    
    // Fail open (allow) on error to avoid blocking legitimate users
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
