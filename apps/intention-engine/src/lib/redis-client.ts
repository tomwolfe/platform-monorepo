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

// Export a proxy that initializes Redis on first use
export const redis = new Proxy({} as ReturnType<typeof getRedisClient>, {
  get(_, prop) {
    const client = getRedisClientLazy();
    return Reflect.get(client, prop);
  }
});

export default redis;
