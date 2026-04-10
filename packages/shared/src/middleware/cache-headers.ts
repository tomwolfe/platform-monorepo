/**
 * Cache-Control Header Middleware
 *
 * Standardizes Cache-Control headers across all API routes.
 * Ensures consistent caching behavior for public vs authenticated endpoints.
 *
 * Usage:
 * ```typescript
 * // In route handler
 * return withCacheHeaders(response, {
 *   type: 'public', // or 'private'
 *   maxAge: 30,
 *   staleWhileRevalidate: 60,
 * });
 * ```
 *
 * @see Task 4: Enforce Next.js 15 Route Segment Caching & Revalidation
 */

import { NextResponse } from "next/server";

// ============================================================================
// TYPES
// ============================================================================

export interface CacheConfig {
  /** Cache type: public (shared CDN) or private (user-specific) */
  type: "public" | "private";
  /** Max-age in seconds for browser cache */
  maxAge?: number;
  /** s-maxage in seconds for CDN cache (public only) */
  sharedMaxAge?: number;
  /** Stale-while-revalidate in seconds */
  staleWhileRevalidate?: number;
  /** No-store override (forces fresh fetch) */
  noStore?: boolean;
  /** Additional custom directives */
  customDirectives?: string[];
}

// ============================================================================
// DEFAULT CONFIGURATIONS
// ============================================================================

/**
 * Default cache config for public read-only endpoints
 * (e.g., /api/prices, /api/v1/availability)
 */
export const PUBLIC_CACHE_CONFIG: CacheConfig = {
  type: "public",
  maxAge: 60,
  sharedMaxAge: 30,
  staleWhileRevalidate: 60,
};

/**
 * Default cache config for authenticated endpoints
 * (e.g., /api/v1/reservation/:id)
 */
export const PRIVATE_CACHE_CONFIG: CacheConfig = {
  type: "private",
  noStore: true,
};

/**
 * No-cache config for real-time/mutation endpoints
 */
export const NO_CACHE_CONFIG: CacheConfig = {
  type: "private",
  noStore: true,
};

// ============================================================================
// CACHE HEADER BUILDER
// ============================================================================

/**
 * Build Cache-Control header value from config
 *
 * @param config - Cache configuration
 * @returns Cache-Control header value string
 */
export function buildCacheControlHeader(config: CacheConfig): string {
  if (config.noStore) {
    return "private, no-store, no-cache";
  }

  const directives: string[] = [];

  if (config.type === "public") {
    directives.push("public");
  } else {
    directives.push("private");
  }

  if (config.maxAge !== undefined) {
    directives.push(`max-age=${config.maxAge}`);
  }

  if (config.type === "public" && config.sharedMaxAge !== undefined) {
    directives.push(`s-maxage=${config.sharedMaxAge}`);
  }

  if (config.staleWhileRevalidate !== undefined) {
    directives.push(`stale-while-revalidate=${config.staleWhileRevalidate}`);
  }

  if (config.customDirectives) {
    directives.push(...config.customDirectives);
  }

  return directives.join(", ");
}

// ============================================================================
// RESPONSE WRAPPER
// ============================================================================

/**
 * Apply cache headers to a NextResponse
 *
 * @param response - The response to modify
 * @param config - Cache configuration
 * @returns The same response with cache headers applied
 *
 * @example
 * ```typescript
 * export const GET = withUnifiedApiHandler(async (req) => {
 *   const data = await fetchData();
 *   const response = NextResponse.json({ success: true, data });
 *   return withCacheHeaders(response, PUBLIC_CACHE_CONFIG);
 * });
 * ```
 */
export function withCacheHeaders<T>(
  response: NextResponse<T>,
  config: CacheConfig = PUBLIC_CACHE_CONFIG,
): NextResponse<T> {
  const headerValue = buildCacheControlHeader(config);
  response.headers.set("Cache-Control", headerValue);
  return response;
}

/**
 * Apply cache headers to a NextResponse (alias for withCacheHeaders)
 */
export function applyCacheControl<T>(
  response: NextResponse<T>,
  config: CacheConfig = PUBLIC_CACHE_CONFIG,
): NextResponse<T> {
  return withCacheHeaders(response, config);
}

// ============================================================================
// TAG INVALIDATION UTILITIES
// ============================================================================

/**
 * Revalidate cache by tag
 * Use this after mutations that affect cached data
 *
 * @param tag - Cache tag to invalidate
 *
 * @example
 * ```typescript
 * // After successful reservation creation
 * await revalidateTag('availability');
 * ```
 */
export { revalidateTag } from "next/cache";
