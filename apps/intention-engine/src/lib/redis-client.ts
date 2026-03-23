import { getRedisClient, ServiceNamespace } from '@repo/shared';

/**
 * Shared Redis Client Wrapper with Namespace Isolation for IntentionEngine
 * Uses ServiceNamespace enum for type-safe namespace isolation
 *
 * Lazy initialization to avoid build-time Redis connection attempts
 */
let _redis: ReturnType<typeof getRedisClient> | null = null;

export const getRedisClientLazy = () => {
  if (!_redis) {
    _redis = getRedisClient(ServiceNamespace.IE);
  }
  return _redis;
};

// Export the client directly without Proxy wrapper
export const redis = getRedisClientLazy();

export default redis;
