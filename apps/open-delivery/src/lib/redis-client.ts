import { getRedisClient } from '@repo/shared';

const PROJECT_PREFIX = 'od:';

export const redis = getRedisClient('OpenDelivery', PROJECT_PREFIX);
export default redis;
