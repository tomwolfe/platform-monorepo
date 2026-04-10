/**
 * User-Level Rate Limiting Middleware
 *
 * Implements distributed rate limiting using @upstash/ratelimit.
 * Prevents a single compromised account from draining LLM quota.
 *
 * Features:
 * - Token bucket / sliding window rate limiting via Upstash Redis
 * - Per-user limits (not IP-based)
 * - Distributed across all serverless instances (no split-brain)
 * - Configurable limits per endpoint type
 * - Explicit fail-open/fail-closed behavior when Redis is unreachable
 *
 * SERVERLESS COMPATIBILITY:
 * All rate limiting state is stored in Upstash Redis to support serverless
 * environments (Vercel). No in-memory state to prevent split-brain rate limiting
 * across multiple serverless instances.
 *
 * Architecture:
 * - @upstash/ratelimit SlidingWindow for accurate rate limiting
 * - Atomic Redis operations for consistency
 * - Fail-closed by default (reject requests when Redis unavailable)
 */

import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { Logger } from "../logger";

const logger = new Logger({ serviceName: "rate-limiter" });

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
    "X-RateLimit-Error"?: string;
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
  private static ratelimitInstances: Map<string, Ratelimit> = new Map();
  private config: EndpointRateLimitConfig;
  private failClosed: boolean;

  constructor(
    config?: Partial<EndpointRateLimitConfig>,
    options?: { failClosed?: boolean },
  ) {
    this.config = { ...DEFAULT_LIMITS, ...config };
    this.failClosed = options?.failClosed ?? true; // Default to fail-closed for security
  }

  static setRedis(redisClient: Redis | null) {
    this.redis = redisClient;
    // Clear cached instances when Redis changes
    this.ratelimitInstances.clear();
  }

  /**
   * Get or create a Ratelimit instance for the given endpoint type.
   * Ratelimit instances are cached for performance.
   */
  private getRatelimitInstance(
    endpointType: keyof EndpointRateLimitConfig,
  ): Ratelimit {
    const cacheKey = endpointType;
    const cached = RateLimiterService.ratelimitInstances.get(cacheKey);

    if (cached) {
      return cached;
    }

    if (!RateLimiterService.redis) {
      throw new Error("Redis client not initialized for RateLimiterService");
    }

    const endpointConfig = this.config[endpointType];

    // Create SlidingWindow ratelimit instance
    const instance = new Ratelimit({
      redis: RateLimiterService.redis,
      limiter: Ratelimit.slidingWindow(
        endpointConfig.maxRequests + endpointConfig.burstAllowance,
        `${endpointConfig.windowMs} ms`,
      ),
      prefix: endpointConfig.keyPrefix,
      analytics: false, // Disable analytics for performance
    });

    RateLimiterService.ratelimitInstances.set(cacheKey, instance);
    return instance;
  }

  async checkRateLimit(
    userId: string,
    endpointType: keyof EndpointRateLimitConfig = "api",
  ): Promise<RateLimitResult> {
    const endpointConfig = this.config[endpointType];

    // Use @upstash/ratelimit for distributed rate limiting
    try {
      return await this.checkRateLimitUpstash(userId, endpointType);
    } catch (error) {
      logger.error({
        message: "Rate limiter Redis error",
        error,
      });

      // Fail-closed: reject requests when Redis is unavailable (secure default)
      if (this.failClosed) {
        logger.warn({
          message: "Rate limiter failing closed - rejecting request",
          endpointType,
          userId,
        });

        return {
          allowed: false,
          remaining: 0,
          resetInMs: endpointConfig.windowMs,
          retryAfter: Math.ceil(endpointConfig.windowMs / 1000),
          headers: {
            "X-RateLimit-Limit": "0",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Date.now() + endpointConfig.windowMs),
            "Retry-After": Math.ceil(endpointConfig.windowMs / 1000).toString(),
            "X-RateLimit-Error": "rate_limiter_unavailable",
          },
          userId,
          endpointType,
        };
      }

      // Fail-open: allow requests when Redis is unavailable (availability over security)
      logger.warn({
        message: "Rate limiter failing open - allowing request",
        endpointType,
        userId,
      });

      return {
        allowed: true,
        remaining: endpointConfig.maxRequests + endpointConfig.burstAllowance,
        resetInMs: endpointConfig.windowMs,
        headers: {
          "X-RateLimit-Limit": String(
            endpointConfig.maxRequests + endpointConfig.burstAllowance,
          ),
          "X-RateLimit-Remaining": String(
            endpointConfig.maxRequests + endpointConfig.burstAllowance,
          ),
          "X-RateLimit-Reset": String(Date.now() + endpointConfig.windowMs),
          "X-RateLimit-Degraded": "true",
        },
        userId,
        endpointType,
      };
    }
  }

  /**
   * Rate limiting using @upstash/ratelimit with SlidingWindow algorithm.
   * Provides accurate rate limiting across all serverless instances.
   */
  private async checkRateLimitUpstash(
    userId: string,
    endpointType: keyof EndpointRateLimitConfig,
  ): Promise<RateLimitResult> {
    const endpointConfig = this.config[endpointType];
    const instance = this.getRatelimitInstance(endpointType);

    const result = await instance.limit(userId);

    const maxRequests =
      endpointConfig.maxRequests + endpointConfig.burstAllowance;
    const remaining = Math.max(0, result.remaining);
    const resetInMs = result.reset.getTime() - Date.now();

    return {
      allowed: result.success,
      remaining,
      resetInMs: Math.max(0, resetInMs),
      retryAfter: result.success
        ? undefined
        : Math.ceil(Math.max(0, resetInMs) / 1000),
      headers: {
        "X-RateLimit-Limit": maxRequests.toString(),
        "X-RateLimit-Remaining": remaining.toString(),
        "X-RateLimit-Reset": result.reset.getTime().toString(),
        ...(result.success
          ? {}
          : {
              "Retry-After": Math.ceil(
                Math.max(0, resetInMs) / 1000,
              ).toString(),
            }),
      },
      userId,
      endpointType,
    };
  }

  /**
   * Get current rate limit status for a user (without consuming)
   */
  async getStatus(
    userId: string,
    endpointType: keyof EndpointRateLimitConfig = "api",
  ): Promise<{
    remaining: number;
    limit: number;
    resetInMs: number;
  }> {
    const endpointConfig = this.config[endpointType];

    // Note: @upstash/ratelimit doesn't support checking status without consuming
    // Return configured limits instead
    return {
      remaining: endpointConfig.maxRequests + endpointConfig.burstAllowance,
      limit: endpointConfig.maxRequests + endpointConfig.burstAllowance,
      resetInMs: endpointConfig.windowMs,
    };
  }

  /**
   * Reset rate limit for a user
   */
  async reset(
    userId: string,
    endpointType?: keyof EndpointRateLimitConfig,
  ): Promise<void> {
    if (!RateLimiterService.redis) {
      throw new Error("Redis client not initialized");
    }

    if (endpointType) {
      const endpointConfig = this.config[endpointType];
      const redisKey = `${endpointConfig.keyPrefix}${userId}`;
      await RateLimiterService.redis.del(redisKey);
    } else {
      // Reset all endpoints for user
      for (const type of Object.keys(this.config) as Array<
        keyof EndpointRateLimitConfig
      >) {
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
  config?: Partial<EndpointRateLimitConfig>,
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
    logger.error({ message: "Middleware error", error });

    // Fail-closed by default for security
    const isCriticalEndpoint = endpointType !== "cache";

    if (isCriticalEndpoint) {
      return {
        allowed: false,
        result: {
          allowed: false,
          remaining: 0,
          resetInMs: 60000,
          headers: {
            "X-RateLimit-Limit": "0",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Date.now() + 60000),
            "X-RateLimit-Error": "rate_limiter_unavailable",
            "Retry-After": "60",
          },
          userId,
          endpointType,
        },
        error:
          "Rate limiter completely unavailable - service temporarily blocked (503)",
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

// ============================================================================
// USER IDENTITY EXTRACTION
// ============================================================================

/**
 * Extract user identity for rate limiting from a NextRequest.
 *
 * Priority:
 * 1. JWT subject (userId from Clerk or similar)
 * 2. x-forwarded-for IP (only for unauthenticated requests)
 * 3. Anonymous fallback
 *
 * This ensures authenticated users are rate-limited individually
 * while unauthenticated users share IP-based limits.
 *
 * @param req - Next.js request object
 * @returns User identifier (userId or IP)
 */
export function extractUserIdentity(req: Request): string {
  // Try JWT-based user ID first (Clerk, Auth.js, etc.)
  const clerkUserId = req.headers.get("x-clerk-user-id");
  const authUserId = req.headers.get("x-user-id");

  if (clerkUserId || authUserId) {
    return clerkUserId || authUserId || "anonymous";
  }

  // Fallback to IP for unauthenticated requests
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) {
    // Use the first IP in the chain (client IP)
    return forwardedFor.split(",")[0]?.trim() || "anonymous";
  }

  const realIp = req.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }

  return "anonymous";
}

// ============================================================================
// EXPRESS/NEXT.JS MIDDLEWARE
// ============================================================================

/**
 * Create rate limit middleware for Next.js API routes
 */
export function createRateLimitMiddleware(
  endpointType: keyof EndpointRateLimitConfig = "api",
  getUserId?: (request: Request) => string,
) {
  return async function rateLimit(request: Request): Promise<{
    allowed: boolean;
    headers?: Record<string, string>;
    error?: string;
  }> {
    // Extract user ID using service-aware identity extraction
    const userId = getUserId
      ? getUserId(request)
      : extractUserIdentity(request);

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
