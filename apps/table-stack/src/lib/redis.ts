import { getRedisClient } from '@repo/shared';

/**
 * Shared Redis Client Wrapper with Namespace Isolation for TableStack
 */
const PROJECT_PREFIX = 'ts:';

export const redis = getRedisClient('TableStack', PROJECT_PREFIX);
export default redis;
