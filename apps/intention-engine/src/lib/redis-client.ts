import { getRedisClient } from '@repo/shared';

const PROJECT_PREFIX = 'ie:';

export const redis = getRedisClient('IntentionEngine', PROJECT_PREFIX);
export default redis;
