/**
 * Rate Limiter - Re-export from @repo/shared
 *
 * This file re-exports the rate limiter from the shared package.
 * The implementation was consolidated to prevent duplication.
 *
 * @see packages/shared/src/middleware/rate-limiter.ts for the full implementation
 */

export {
  RateLimiterService,
  rateLimitMiddleware,
  DEFAULT_LIMITS,
  type RateLimitConfig,
  type EndpointRateLimitConfig,
  type RateLimitResult,
} from "@repo/shared/middleware/rate-limiter";
