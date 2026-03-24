/**
 * Standardized Cache Layer
 * 
 * Unified Redis caching for all apps. Eliminates duplicated Redis clients.
 * 
 * Features:
 * - Namespace isolation
 * - TTL management
 * - Type-safe operations
 * - Circuit breaker integration
 * 
 * @see Phase 2.3: Standardize Redis + Persistence
 */

import { Redis } from "@upstash/redis";
import { getRedisConfig, ServiceNamespace, getNamespacePrefix } from "../redis";

// ============================================================================
// CACHE CONFIGURATION
// ============================================================================

export interface CacheConfig {
  namespace: ServiceNamespace;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  keyPrefix: string;
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  namespace: ServiceNamespace.SHARED,
  defaultTtlSeconds: 3600, // 1 hour
  maxTtlSeconds: 604800, // 7 days
  keyPrefix: "",
};

// ============================================================================
// CACHE ENTRY
// ============================================================================

export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  createdAt: string;
  expiresAt?: string;
  ttlSeconds?: number;
  version: number;
}

// ============================================================================
// CACHE CLIENT
// ============================================================================

export class CacheClient {
  private redis: Redis;
  private config: CacheConfig;

  constructor(config?: Partial<CacheConfig>) {
    const namespace = config?.namespace || DEFAULT_CACHE_CONFIG.namespace;
    this.config = {
      ...DEFAULT_CACHE_CONFIG,
      ...config,
      namespace,
      keyPrefix: getNamespacePrefix(namespace),
    };

    const { url, token } = getRedisConfig(namespace);
    this.redis = new Redis({ url, token });
  }

  // ========================================================================
  // KEY GENERATION
  // ========================================================================

  private buildKey(key: string): string {
    return `${this.config.keyPrefix}${key}`;
  }

  // ========================================================================
  // GET
  // ========================================================================

  async get<T = unknown>(key: string): Promise<T | null> {
    const fullKey = this.buildKey(key);
    const data = await this.redis.get<string>(fullKey);
    if (!data) return null;

    try {
      const entry = JSON.parse(data) as CacheEntry<T>;
      return entry.value;
    } catch {
      // If parsing fails, return raw value
      return data as unknown as T;
    }
  }

  // ========================================================================
  // SET
  // ========================================================================

  async set<T = unknown>(
    key: string,
    value: T,
    options?: { ttlSeconds?: number; version?: number }
  ): Promise<void> {
    const fullKey = this.buildKey(key);
    const ttlSeconds = options?.ttlSeconds || this.config.defaultTtlSeconds;
    const effectiveTtl = Math.min(ttlSeconds, this.config.maxTtlSeconds);

    const entry: CacheEntry<T> = {
      key: fullKey,
      value,
      createdAt: new Date().toISOString(),
      expiresAt: effectiveTtl > 0
        ? new Date(Date.now() + effectiveTtl * 1000).toISOString()
        : undefined,
      ttlSeconds: effectiveTtl > 0 ? effectiveTtl : undefined,
      version: options?.version || 1,
    };

    if (effectiveTtl > 0) {
      await this.redis.setex(fullKey, effectiveTtl, JSON.stringify(entry));
    } else {
      await this.redis.set(fullKey, JSON.stringify(entry));
    }
  }

  // ========================================================================
  // DELETE
  // ========================================================================

  async delete(key: string): Promise<boolean> {
    const fullKey = this.buildKey(key);
    const result = await this.redis.del(fullKey);
    return result > 0;
  }

  // ========================================================================
  // EXISTS
  // ========================================================================

  async exists(key: string): Promise<boolean> {
    const fullKey = this.buildKey(key);
    const result = await this.redis.exists(fullKey);
    return result > 0;
  }

  // ========================================================================
  // INCREMENT
  // ========================================================================

  async increment(key: string, by?: number): Promise<number> {
    const fullKey = this.buildKey(key);
    return this.redis.incrby(fullKey, by || 1) as Promise<number>;
  }

  // ========================================================================
  // DECREMENT
  // ========================================================================

  async decrement(key: string, by?: number): Promise<number> {
    const fullKey = this.buildKey(key);
    return this.redis.decrby(fullKey, by || 1) as Promise<number>;
  }

  // ========================================================================
  // GET COUNTER
  // ========================================================================

  async getCounter(key: string): Promise<number> {
    const fullKey = this.buildKey(key);
    const value = await this.redis.get<number>(fullKey);
    return value || 0;
  }

  // ========================================================================
  // SET IF NOT EXISTS (NX)
  // ========================================================================

  async setNx<T = unknown>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    const fullKey = this.buildKey(key);
    const entry = JSON.stringify({
      key: fullKey,
      value,
      createdAt: new Date().toISOString(),
      version: 1,
    });

    const result = await this.redis.set(fullKey, entry, {
      nx: true,
      ex: ttlSeconds || this.config.defaultTtlSeconds,
    });

    return result === "OK";
  }

  // ========================================================================
  // KEYS (with pattern)
  // ========================================================================

  async keys(pattern: string): Promise<string[]> {
    const fullPattern = `${this.config.keyPrefix}${pattern}`;
    const keys = await this.redis.keys(fullPattern);
    // Strip prefix from results
    return keys.map((k) => k.replace(this.config.keyPrefix, ""));
  }

  // ========================================================================
  // FLUSH NAMESPACE
  // ========================================================================

  async flush(): Promise<number> {
    const keys = await this.keys("*");
    if (keys.length === 0) return 0;

    const fullKeys = keys.map((k) => this.buildKey(k));
    await this.redis.del(...fullKeys);
    return keys.length;
  }

  // ========================================================================
  // HEALTH CHECK
  // ========================================================================

  async ping(): Promise<boolean> {
    try {
      const result = await this.redis.ping();
      return result === "PONG";
    } catch {
      return false;
    }
  }

  // ========================================================================
  // GET RAW REDIS CLIENT
  // For advanced operations
  // ========================================================================

  getRawClient(): Redis {
    return this.redis;
  }
}

// ============================================================================
// NAMESPACE-SPECIFIC CACHE CLIENTS
// Convenience factories for each app namespace
// ============================================================================

export function getIntentionEngineCache(config?: Partial<CacheConfig>): CacheClient {
  return new CacheClient({
    ...config,
    namespace: ServiceNamespace.IE,
  });
}

export function getTableStackCache(config?: Partial<CacheConfig>): CacheClient {
  return new CacheClient({
    ...config,
    namespace: ServiceNamespace.TS,
  });
}

export function getOpenDeliveryCache(config?: Partial<CacheConfig>): CacheClient {
  return new CacheClient({
    ...config,
    namespace: ServiceNamespace.OD,
  });
}

export function getSharedCache(config?: Partial<CacheConfig>): CacheClient {
  return new CacheClient({
    ...config,
    namespace: ServiceNamespace.SHARED,
  });
}

// ============================================================================
// GLOBAL CACHE CLIENT
// Singleton for shared cache access
// ============================================================================

let globalCacheClient: CacheClient | null = null;

export function getGlobalCache(): CacheClient {
  if (!globalCacheClient) {
    globalCacheClient = getSharedCache();
  }
  return globalCacheClient;
}

export function setGlobalCache(client: CacheClient): void {
  globalCacheClient = client;
}
