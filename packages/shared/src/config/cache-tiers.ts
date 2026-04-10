/**
 * Cache Tier Configuration
 *
 * Centralized TTL management for Redis cache layers.
 * Replaces hardcoded `ex: 60` or `ex: 86400` values with named constants.
 *
 * Usage:
 * ```typescript
 * await redis.set(key, value, { ex: CACHE_TIERS.SHORT });
 * await redis.set(key, value, { ex: CACHE_TIERS.MEDIUM });
 * ```
 *
 * TTL Guidelines:
 * - SHORT (60s):     Rate limits, locks, transient state
 * - MEDIUM (15m):    API responses, user sessions, feature flags
 * - LONG (1h):       Reference data, configuration, frequently accessed data
 * - EXTENDED (24h):  Static content, cached computations, daily snapshots
 *
 * @package @repo/shared
 * @since 1.0.0
 */

export const CACHE_TIERS = {
  /** 60 seconds - Rate limits, distributed locks, transient state */
  SHORT: 60,

  /** 15 minutes (900s) - API responses, user sessions, feature flags */
  MEDIUM: 900,

  /** 1 hour (3600s) - Reference data, configuration, frequently accessed */
  LONG: 3600,

  /** 24 hours (86400s) - Static content, cached computations, daily snapshots */
  EXTENDED: 86400,
} as const;

export type CacheTier = keyof typeof CACHE_TIERS;
export type CacheTTLValue = (typeof CACHE_TIERS)[CacheTier];

/**
 * Get TTL value by tier name
 *
 * @param tier - Cache tier name
 * @returns TTL in seconds
 *
 * @example
 * ```typescript
 * const ttl = getTTL('MEDIUM'); // 900
 * await redis.set(key, value, { ex: ttl });
 * ```
 */
export function getTTL(tier: CacheTier): number {
  return CACHE_TIERS[tier];
}

/**
 * Validate that a TTL value matches a known tier
 *
 * @param ttl - TTL value in seconds
 * @returns true if TTL matches a known tier
 *
 * @example
 * ```typescript
 * if (!isValidTTL(customTTL)) {
 *   throw new Error(`Invalid TTL: ${customTTL}`);
 * }
 * ```
 */
export function isValidTTL(ttl: number): boolean {
  return Object.values(CACHE_TIERS).includes(ttl as CacheTTLValue);
}

/**
 * Get human-readable description of a TTL tier
 *
 * @param ttl - TTL value in seconds
 * @returns Human-readable description
 *
 * @example
 * ```typescript
 const desc = describeTTL(900); // "15 minutes (MEDIUM)"
 * ```
 */
export function describeTTL(ttl: number): string {
  const tierMap: Record<number, string> = {
    [CACHE_TIERS.SHORT]: "1 minute (SHORT)",
    [CACHE_TIERS.MEDIUM]: "15 minutes (MEDIUM)",
    [CACHE_TIERS.LONG]: "1 hour (LONG)",
    [CACHE_TIERS.EXTENDED]: "24 hours (EXTENDED)",
  };

  return tierMap[ttl] || `${ttl} seconds (CUSTOM)`;
}
