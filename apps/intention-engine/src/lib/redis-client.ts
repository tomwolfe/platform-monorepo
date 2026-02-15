import { getRedisClient, ServiceNamespace } from '@repo/shared';

/**
 * Shared Redis Client Wrapper with Namespace Isolation for IntentionEngine
 * Uses ServiceNamespace enum for type-safe namespace isolation
 */
export const redis = getRedisClient(ServiceNamespace.IE);
export default redis;
