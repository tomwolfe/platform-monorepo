import { Redis } from '@upstash/redis';

export function wrapWithPrefix(obj: any, prefix: string): any {
  return new Proxy(obj, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === 'function') {
        return (...args: any[]) => {
          // Special handling for keys()
          if (prop === 'keys') {
            const pattern = args[0] || '*';
            return target.keys(prefix + pattern).then((keys: string[]) => 
              keys.map((k: string) => k.startsWith(prefix) ? k.slice(prefix.length) : k)
            );
          }
          
          // Custom flushdb()
          if (prop === 'flushdb' || prop === 'flushall') {
            return (async () => {
              const keys = await target.keys(prefix + '*');
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
              args[1].match = prefix + args[1].match;
            }
            return target.scan(...args).then(([cursor, keys]: [string, string[]]) => [
              cursor,
              keys.map((k: string) => k.startsWith(prefix) ? k.slice(prefix.length) : k)
            ]);
          }

          // Optimized prefixing for hot paths
          if (typeof args[0] === 'string' && !['info', 'ping', 'echo', 'quit'].includes(prop as string)) {
            args[0] = prefix + args[0];
            
            // Handle multiple keys in del, exists, etc.
            if (prop === 'del' || prop === 'exists' || prop === 'unlink') {
              for (let i = 1; i < args.length; i++) {
                if (typeof args[i] === 'string') args[i] = prefix + args[i];
              }
            }
          }
          
          return value.apply(target, args);
        };
      }
      return value;
    }
  });
}

export const getRedisConfig = (appName: string) => {
  const url = process.env.SHARED_UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL || 'http://localhost:8080';
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || 'example_token';
  
  if (!process.env.UPSTASH_REDIS_REST_URL && !process.env.SHARED_UPSTASH_REDIS_REST_URL) {
    console.warn(`${appName}: Redis environment variables are missing, defaulting to localhost`);
  }
  
  return { url, token };
};
