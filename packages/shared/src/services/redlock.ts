/**
 * Redlock Algorithm - Distributed Locking with Quorum
 *
 * ⚠️  DEPRECATED: This implementation is deprecated and will be removed in a future release.
 *
 * Reason for Deprecation:
 * - Redlock requires multiple independent Redis instances for proper quorum
 * - In serverless environments (Vercel), clock skew and process termination can leave locks stale
 * - Single Redis with Lua scripts (distributed-lock.ts) provides sufficient safety
 *   with lower complexity and fewer failure modes
 *
 * Migration Path:
 * - Replace `withRedlock(key, validityMs, fn)` with `withDistributedLock(key, ttlSeconds, fn)`
 * - Replace `createRedlock(options)` with direct usage of `acquireDistributedLock` / `releaseDistributedLock`
 *
 * The new implementation in `packages/shared/src/services/distributed-lock.ts` uses
 * Redis Lua scripts for atomicity, which is simpler, more reliable, and better suited
 * for serverless deployments.
 *
 * @deprecated Use `withDistributedLock` from './distributed-lock' instead
 * @package @repo/shared
 * @since 1.0.0
 */

import { Redis } from "@upstash/redis";

/**
 * Generate a random UUID v4
 * Uses Node.js crypto module for cryptographically secure randomness
 */
function randomUUID(): string {
  return crypto.randomUUID();
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface RedlockResource {
  redis: Redis;
  name?: string; // For debugging
}

export interface RedlockConfig {
  /** Array of Redis resources (should be independent instances) */
  resources: RedlockResource[];
  /** Quorum required (N/2 + 1 where N is number of resources) */
  quorum: number;
  /** Maximum retry count for lock acquisition */
  retryCount: number;
  /** Base delay between retries in ms */
  retryDelay: number;
  /** Maximum drift time factor (0.01 = 1%) */
  driftFactor: number;
  /** Enable debug logging */
  debug: boolean;
}

export interface RedlockLock {
  /** Lock key */
  key: string;
  /** Unique lock identifier */
  lockId: string;
  /** Lock validity in milliseconds */
  validityMs: number;
  /** When lock was acquired */
  acquiredAt: number;
  /** Number of instances that granted the lock */
  quorumCount: number;
  /** Release the lock */
  release(): Promise<ReleaseResult>;
  /** Extend the lock validity */
  extend(additionalMs: number): Promise<ExtendResult>;
}

export interface ReleaseResult {
  success: boolean;
  releasedFrom: number; // Number of instances released from
  error?: string;
}

export interface ExtendResult {
  success: boolean;
  newValidityMs: number;
  extendedOn: number; // Number of instances extended on
  error?: string;
}

export interface AcquireResult {
  success: boolean;
  lock?: RedlockLock;
  error?: string;
  attempts?: number;
}

// ============================================================================
// DEFAULT CONFIGURATION
// ============================================================================

const DEFAULT_CONFIG: Partial<RedlockConfig> = {
  retryCount: 3,
  retryDelay: 200, // ms
  driftFactor: 0.01, // 1%
  debug: false,
};

// ============================================================================
// LUA SCRIPTS FOR ATOMIC OPERATIONS
// ============================================================================

/**
 * Atomic Lua script for releasing locks safely.
 * Prevents race conditions where a lock expires between GET and DEL,
 * and another process acquires it - the first process would then delete
 * the new owner's lock.
 */
const LUA_RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/**
 * Atomic Lua script for extending lock TTL safely.
 */
const LUA_EXTEND_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("expire", KEYS[1], tonumber(ARGV[2]))
  else
    return 0
  end
`;

// ============================================================================
// REDLOCK CLIENT
// ============================================================================

export class RedlockClient {
  private config: Required<RedlockConfig>;

  constructor(config: RedlockConfig) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      quorum: config.quorum || Math.floor(config.resources.length / 2) + 1,
    } as Required<RedlockConfig>;

    if (this.config.debug) {
      console.log(
        `[Redlock] Initialized with ${this.config.resources.length} resources, ` +
          `quorum=${this.config.quorum}`,
      );
    }
  }

  /**
   * Acquire a distributed lock
   *
   * @param key - Lock key
   * @param validityMs - Lock validity period in milliseconds
   * @param options - Optional acquire options
   * @returns Lock instance or error
   */
  async acquire(
    key: string,
    validityMs: number,
    options?: {
      retryCount?: number;
    },
  ): Promise<AcquireResult> {
    const maxRetries = options?.retryCount ?? this.config.retryCount;
    let lastError: string | undefined;
    let attempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts++;
      const startTime = Date.now();
      const lockId = randomUUID();

      try {
        // Try to acquire on all resources in parallel
        const acquirePromises = this.config.resources.map(
          async (resource, index) => {
            try {
              const result = await resource.redis.set(key, lockId, {
                nx: true,
                ex: Math.ceil(validityMs / 1000), // Convert to seconds
              });

              return {
                index,
                success: result === "OK",
                name: resource.name || `redis-${index}`,
              };
            } catch (error) {
              if (this.config.debug) {
                console.error(
                  `[Redlock] Failed to acquire on ${resource.name || index}:`,
                  error,
                );
              }
              return {
                index,
                success: false,
                name: resource.name || `redis-${index}`,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        );

        const results = await Promise.all(acquirePromises);
        const successful = results.filter((r) => r.success);
        const elapsed = Date.now() - startTime;

        // Calculate drift (time spent acquiring)
        const drift = Math.ceil(elapsed * this.config.driftFactor) + 2; // +2ms buffer
        const validityWithDrift = validityMs - drift;

        if (this.config.debug) {
          console.log(
            `[Redlock] Acquire attempt ${attempt + 1}/${maxRetries + 1} for ${key}: ` +
              `${successful.length}/${this.config.resources.length} successful, ` +
              `elapsed=${elapsed}ms, drift=${drift}ms`,
          );
        }

        // Check if we have quorum
        if (successful.length >= this.config.quorum && validityWithDrift > 0) {
          if (this.config.debug) {
            console.log(
              `[Redlock] Lock acquired for ${key} (quorum=${successful.length}, ` +
                `validity=${validityWithDrift}ms)`,
            );
          }

          return {
            success: true,
            lock: this.createLock(
              key,
              lockId,
              validityWithDrift,
              successful.length,
            ),
            attempts,
          };
        }

        // Failed to acquire quorum - release any locks we got
        await this.releasePartial(key, lockId, results);

        lastError = `Failed to acquire quorum (${successful.length}/${this.config.quorum})`;

        // Exponential backoff before retry
        if (attempt < maxRetries) {
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          const jitter = Math.random() * 0.2 * delay;
          await this.sleep(delay + jitter);
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);

        if (this.config.debug) {
          console.error(
            `[Redlock] Acquire attempt ${attempt + 1} failed:`,
            error,
          );
        }

        // Backoff before retry
        if (attempt < maxRetries) {
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          const jitter = Math.random() * 0.2 * delay;
          await this.sleep(delay + jitter);
        }
      }
    }

    if (this.config.debug) {
      console.warn(
        `[Redlock] Failed to acquire lock ${key} after ${attempts} attempts: ${lastError}`,
      );
    }

    return {
      success: false,
      error: lastError,
      attempts,
    };
  }

  /**
   * Create lock instance
   */
  private createLock(
    key: string,
    lockId: string,
    validityMs: number,
    quorumCount: number,
  ): RedlockLock {
    const acquiredAt = Date.now();

    return {
      key,
      lockId,
      validityMs,
      acquiredAt,
      quorumCount,

      release: async () => {
        return this.release(key, lockId);
      },

      extend: async (additionalMs: number) => {
        return this.extend(key, lockId, additionalMs);
      },
    };
  }

  /**
   * Release a lock using atomic Lua script
   * Prevents race condition where lock expires between GET and DEL
   */
  async release(key: string, lockId: string): Promise<ReleaseResult> {
    try {
      const releasePromises = this.config.resources.map(
        async (resource, index) => {
          try {
            // Use atomic Lua script to safely release only if we still own it
            const result = await resource.redis.eval(
              LUA_RELEASE_SCRIPT,
              [key], // KEYS
              [lockId], // ARGV
            );

            const success = result === 1;
            return {
              index,
              success,
              name: resource.name || `redis-${index}`,
              reason: success ? undefined : "not_owner",
            };
          } catch (error) {
            if (this.config.debug) {
              console.error(
                `[Redlock] Failed to release on ${resource.name || index}:`,
                error,
              );
            }
            return {
              index,
              success: false,
              name: resource.name || `redis-${index}`,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      );

      const results = await Promise.all(releasePromises);
      const successful = results.filter((r) => r.success);

      if (this.config.debug) {
        console.log(
          `[Redlock] Released lock ${key} on ${successful.length}/${this.config.resources.length} resources`,
        );
      }

      return {
        success: true,
        releasedFrom: successful.length,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Redlock] Release failed for ${key}:`, errorMsg);
      return {
        success: false,
        releasedFrom: 0,
        error: errorMsg,
      };
    }
  }

  /**
   * Extend a lock's validity using atomic Lua script
   */
  async extend(
    key: string,
    lockId: string,
    additionalMs: number,
  ): Promise<ExtendResult> {
    try {
      const extendPromises = this.config.resources.map(
        async (resource, index) => {
          try {
            // Use atomic Lua script to safely extend only if we still own it
            const expireSeconds = Math.ceil(additionalMs / 1000);
            const result = await resource.redis.eval(
              LUA_EXTEND_SCRIPT,
              [key], // KEYS
              [lockId, String(expireSeconds)], // ARGV
            );

            const success = result === 1;
            return { index, success, name: resource.name || `redis-${index}` };
          } catch (error) {
            if (this.config.debug) {
              console.error(
                `[Redlock] Failed to extend on ${resource.name || index}:`,
                error,
              );
            }
            return {
              index,
              success: false,
              name: resource.name || `redis-${index}`,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      );

      const results = await Promise.all(extendPromises);
      const successful = results.filter((r) => r.success);

      // Need quorum to successfully extend
      if (successful.length >= this.config.quorum) {
        if (this.config.debug) {
          console.log(
            `[Redlock] Extended lock ${key} by ${additionalMs}ms on ${successful.length} resources`,
          );
        }

        return {
          success: true,
          newValidityMs: additionalMs,
          extendedOn: successful.length,
        };
      }

      return {
        success: false,
        newValidityMs: 0,
        extendedOn: successful.length,
        error: `Failed to extend quorum (${successful.length}/${this.config.quorum})`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[Redlock] Extend failed for ${key}:`, errorMsg);
      return {
        success: false,
        newValidityMs: 0,
        extendedOn: 0,
        error: errorMsg,
      };
    }
  }

  /**
   * Release partial locks (when quorum not achieved)
   * Uses atomic Lua script to prevent race conditions
   */
  private async releasePartial(
    key: string,
    lockId: string,
    acquireResults: Array<{ index: number; success: boolean; name: string }>,
  ): Promise<void> {
    const releasePromises = acquireResults
      .filter((r) => r.success)
      .map(async (result) => {
        const resource = this.config.resources[result.index];
        try {
          // Use atomic Lua script to safely release only if we still own it
          await resource.redis.eval(
            LUA_RELEASE_SCRIPT,
            [key], // KEYS
            [lockId], // ARGV
          );
        } catch (error) {
          if (this.config.debug) {
            console.error(
              `[Redlock] Failed to release partial on ${result.name}:`,
              error,
            );
          }
        }
      });

    await Promise.all(releasePromises);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get lock statistics
   */
  async getStats(): Promise<{
    totalResources: number;
    quorumRequired: number;
    healthyResources: number;
  }> {
    const healthPromises = this.config.resources.map(
      async (resource, index) => {
        try {
          await resource.redis.ping();
          return {
            index,
            healthy: true,
            name: resource.name || `redis-${index}`,
          };
        } catch {
          return {
            index,
            healthy: false,
            name: resource.name || `redis-${index}`,
          };
        }
      },
    );

    const results = await Promise.all(healthPromises);
    const healthy = results.filter((r) => r.healthy).length;

    return {
      totalResources: this.config.resources.length,
      quorumRequired: this.config.quorum,
      healthyResources: healthy,
    };
  }
}

// ============================================================================
// SINGLETON REDIS RESOURCES
// For single-Redis deployments, simulate multi-resource with different key prefixes
// ============================================================================

/**
 * Create simulated multi-resource client for single-Redis deployments
 *
 * This provides Redlock-like safety even with a single Redis instance
 * by using independent key namespaces and requiring multiple "virtual" acquisitions
 */
export function createVirtualRedlockResources(
  redis: Redis,
  count: number = 3,
): RedlockResource[] {
  return Array.from({ length: count }, (_, i) => ({
    redis,
    name: `virtual-redis-${i}`,
  }));
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

export interface RedlockOptions {
  resources?: RedlockResource[];
  redis?: Redis; // For single-Redis deployments
  quorum?: number;
  retryCount?: number;
  retryDelay?: number;
  driftFactor?: number;
  debug?: boolean;
}

/**
 * Create Redlock client
 *
 * @param options - Configuration options
 * @returns RedlockClient instance
 */
export function createRedlock(options: RedlockOptions = {}): RedlockClient {
  let resources = options.resources;

  // If no resources provided but redis is, create virtual resources
  if (!resources && options.redis) {
    resources = createVirtualRedlockResources(options.redis, 3);
  }

  if (!resources || resources.length === 0) {
    throw new Error(
      "Redlock requires either 'resources' array or single 'redis' instance",
    );
  }

  const quorum = options.quorum || Math.floor(resources.length / 2) + 1;

  return new RedlockClient({
    resources,
    quorum,
    retryCount: options.retryCount ?? 3,
    retryDelay: options.retryDelay ?? 200,
    driftFactor: options.driftFactor ?? 0.01,
    debug: options.debug ?? false,
  });
}

/**
 * Acquire a redlock with automatic release
 *
 * Convenience function for one-off lock acquisitions
 */
export async function withRedlock<T>(
  key: string,
  validityMs: number,
  fn: (lock: RedlockLock) => Promise<T>,
  options?: RedlockOptions,
): Promise<T> {
  const redlock = createRedlock(options);

  const result = await redlock.acquire(key, validityMs);

  if (!result.success || !result.lock) {
    throw new Error(
      `Failed to acquire redlock ${key}: ${result.error || "unknown error"}`,
    );
  }

  try {
    return await fn(result.lock);
  } finally {
    await result.lock.release();
  }
}

// ============================================================================
// FACTORY EXPORTS
// ============================================================================
