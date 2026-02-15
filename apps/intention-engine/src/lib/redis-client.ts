import { Redis } from '@upstash/redis';

/**
 * Shared Redis Client Wrapper with Namespace Isolation for IntentionEngine
 */

const PROJECT_PREFIX = 'ie:';

const SHARED_URL = process.env.SHARED_UPSTASH_REDIS_REST_URL;
const PROJECT_URL = process.env.UPSTASH_REDIS_REST_URL;
const PROJECT_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const redisConfig = {
  url: SHARED_URL || PROJECT_URL || '',
  token: PROJECT_TOKEN || '',
};

const rawRedis = new Redis(redisConfig);

function wrapWithPrefix(obj: any, prefix: string): any {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return (...args: any[]) => {
          // Special handling for keys()
          if (prop === 'keys') {
            const pattern = args[0] || '*';
            return target.keys(`${prefix}${pattern}`).then((keys: string[]) => 
              keys.map((k: string) => k.startsWith(prefix) ? k.slice(prefix.length) : k)
            );
          }
          
          // Custom flushdb()
          if (prop === 'flushdb' || prop === 'flushall') {
            return (async () => {
              const keys = await target.keys(`${prefix}*`);
              if (keys.length > 0) {
                return await target.del(...keys);
              }
              return 0;
            })();
          }

          // Wrap pipeline and multi
          if (prop === 'pipeline' || prop === 'multi') {
            const result = value.apply(target, args);
            return wrapWithPrefix(result, prefix);
          }

          // Special handling for scan results
          if (prop === 'scan') {
            if (args[1]?.match) {
              args[1].match = `${prefix}${args[1].match}`;
            }
            return target.scan(...args).then(([cursor, keys]: [string, string[]]) => [
              cursor,
              keys.map((k: string) => k.startsWith(prefix) ? k.slice(prefix.length) : k)
            ]);
          }

          // Prefix the key for most commands

          return value.apply(target, args);
        };
      }
      return value;
    }
  });
}

export const redis = wrapWithPrefix(rawRedis, PROJECT_PREFIX) as Redis;
export default redis;
