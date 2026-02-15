import { getRedisClient, ServiceNamespace } from '@repo/shared';

/**
 * Shared Redis Client Wrapper with Namespace Isolation for TableStack
 * Uses ServiceNamespace enum for type-safe namespace isolation
 */
export const redis = getRedisClient(ServiceNamespace.TS);
export default redis;
