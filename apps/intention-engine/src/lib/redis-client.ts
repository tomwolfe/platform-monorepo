/**
 * Redis Client Adapter
 *
 * Compatibility layer for tests and scripts that expect
 * a local `@/lib/redis-client` import path.
 *
 * Re-exports the shared Redis client from @repo/shared
 * with the IntentionEngine namespace.
 */

import { getRedisClient, ServiceNamespace } from "@repo/shared";

export { getRedisClient, ServiceNamespace };

// Default export for convenience
export const redis = getRedisClient(ServiceNamespace.IE);
