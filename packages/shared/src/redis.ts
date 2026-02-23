import { Redis } from '@upstash/redis';

/**
 * Service Namespace Enum
 * Enforces namespace isolation across all services
 */
export enum ServiceNamespace {
  IE = "ie",      // Intention Engine
  OD = "od",      // Open Delivery
  TS = "ts",      // Table Stack
  SHARED = "shared",
}

/**
 * Get the prefix for a service namespace
 */
export function getNamespacePrefix(namespace: ServiceNamespace): string {
  return `${namespace}:`;
}

/**
 * Create a Redis client with namespace isolation
 * Requires explicit ServiceNamespace to prevent key collisions
 */
export function getRedisClient(namespace: ServiceNamespace): Redis {
  const { url, token } = getRedisConfig(namespace);
  const baseClient = new Redis({ url, token });
  return wrapWithPrefix(baseClient, getNamespacePrefix(namespace));
}

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
  const url = process.env.SHARED_UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  // CRITICAL: Fail fast in production runtime if Redis is not configured
  // We allow CI/test environments to use fallback values
  const isProductionRuntime = process.env.NODE_ENV === 'production' && process.env.CI !== 'true';

  if (!url || !token) {
    if (isProductionRuntime) {
      throw new Error(
        `CRITICAL: Redis configuration missing for ${appName}. ` +
        'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables.'
      );
    }
    // Development/CI/test: provide fallback without warnings in CI
    if (process.env.CI !== 'true' && process.env.NODE_ENV !== 'test') {
      console.warn(
        `[${appName}] Redis environment variables missing. ` +
        'Using localhost fallback. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for production.'
      );
    }
    // Use localhost for CI/test/development
    return {
      url: 'http://localhost:6379',
      token: 'test_token'
    };
  }

  return { url, token };
};
