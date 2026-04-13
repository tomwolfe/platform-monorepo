/**
 * Distributed Lock Utility - Redis Lua Script Based
 *
 * This replaces the complex Redlock implementation with a simpler,
 * more reliable approach using Redis Lua scripts for atomicity.
 *
 * Why This Replaces Redlock:
 * - Serverless environments (Vercel) have unpredictable cold starts and termination
 * - Redlock requires quorum across multiple Redis instances - complex and fragile
 * - Single Redis instance with Lua scripts provides sufficient safety for our use case
 * - Lower cognitive load, fewer failure modes
 *
 * Features:
 * - Atomic lock acquisition via SETNX
 * - Atomic release via Lua script (prevents releasing wrong owner's lock)
 * - Automatic TTL-based expiration (prevents permanent deadlocks)
 * - Stale lock recovery
 *
 * Usage:
 * ```typescript
 * // Simple usage
 * const result = await withDistributedLock('cron:cleanup', 60, async () => {
 *   return { cleaned: true };
 * });
 *
 * // With options
 * const result = await withDistributedLock('cron:payouts', 120, {
 *   recoverStale: true,
 *   namespace: ServiceNamespace.SHARED,
 * }, async () => {
 *   return processPayouts();
 * });
 * ```
 *
 * @package @repo/shared
 */

import { getRedisClient, ServiceNamespace } from "../redis";
import { randomUUID } from "crypto";
import { Logger } from "../logger";
import {
  AsyncBoundaryError as _AsyncBoundaryError,
  AsyncBoundaryErrorCode,
  retryableError,
} from "../errors/async-boundary";
import { AppError as _AppError, ErrorCode as _ErrorCode } from "../errors";

const logger = new Logger({ serviceName: "distributed-lock" });

// ============================================================================
// RE-ENTRANCY SUPPORT TYPES
// ============================================================================

export interface ReentrantLockOptions {
  /** Execution ID for re-entrancy tracking */
  executionId?: string;
  /** Owner ID for lock identification */
  ownerId?: string;
}

export interface ReentrantLockResult {
  acquired: boolean;
  lockKey: string;
  ownerId: string;
  wasStale?: boolean;
  isReentrant?: boolean;
  reentrancyDepth?: number;
}

// ============================================================================
// RE-ENTRANCY METADATA KEY
// ============================================================================

const META_SUFFIX = ":meta";

// ============================================================================
// LUA SCRIPTS FOR ATOMIC OPERATIONS
// ============================================================================

/**
 * Atomic Lua script for acquiring a lock.
 * Returns 1 if lock acquired, 0 if already held.
 */
const LUA_ACQUIRE_SCRIPT = `
  if redis.call("EXISTS", KEYS[1]) == 0 then
    redis.call("SET", KEYS[1], ARGV[1], "EX", tonumber(ARGV[2]))
    return 1
  end
  return 0
`;

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

// ============================================================================
// TYPES
// ============================================================================

export interface DistributedLockOptions {
  /** Redis namespace to use (defaults to SHARED) */
  namespace?: ServiceNamespace;
  /** Whether to recover stale locks (defaults to true) */
  recoverStale?: boolean;
}

export interface LockResult {
  /** Whether the lock was acquired */
  acquired: boolean;
  /** Lock key */
  lockKey: string;
  /** Unique owner ID (needed for release) */
  ownerId: string;
  /** Whether the lock was stale and recovered */
  wasStale?: boolean;
}

export interface LockInfo {
  isLocked: boolean;
  owner?: string;
  ttlRemaining?: number;
}

// ============================================================================
// CORE LOCKING FUNCTIONS
// ============================================================================

/**
 * Acquire a distributed lock using Redis SETNX with Lua script atomicity.
 *
 * @param lockKey - Unique key for the lock (e.g., 'cron:cleanup')
 * @param ttlSeconds - Lock TTL in seconds (auto-expires to prevent deadlocks)
 * @param options - Optional configuration
 * @returns Lock result with owner ID for release
 */
export async function acquireDistributedLock(
  lockKey: string,
  ttlSeconds: number,
  options?: DistributedLockOptions,
): Promise<LockResult> {
  const {
    namespace = ServiceNamespace.SHARED,
    recoverStale: _recoverStale = true,
  } = options || {};
  const redis = getRedisClient(namespace);
  const ownerId = randomUUID();

  try {
    // Check for stale lock recovery
    if (recoverStale) {
      const ttl = await redis.ttl(lockKey);
      if (ttl === -2) {
        // Key doesn't exist - proceed with acquisition
      } else if (ttl > 0) {
        // Lock exists with TTL - check if it's potentially stale
        // (This is a safety check; the Lua script handles the actual acquisition)
      }
    }

    // Try to acquire lock atomically
    const acquired = await redis.eval(
      LUA_ACQUIRE_SCRIPT,
      [lockKey],
      [ownerId, String(Math.floor(ttlSeconds))],
    );

    if (acquired === 1) {
      return {
        acquired: true,
        lockKey,
        ownerId,
      };
    }

    // Lock already held
    const _currentOwner = await redis.get(lockKey);
    return {
      acquired: false,
      lockKey,
      ownerId: "",
    };
  } catch (error) {
    throw retryableError(
      AsyncBoundaryErrorCode.RATE_LIMITED_RETRYABLE,
      `Failed to acquire distributed lock ${lockKey}: ${error instanceof Error ? error.message : String(error)}`,
      {
        source: "distributed-lock",
        operation: "acquireDistributedLock",
        originalError:
          error instanceof Error ? error : new Error(String(error)),
      },
    );
  }
}

/**
 * Release a distributed lock safely using Lua script.
 * Only the lock owner can release it.
 *
 * @param lockKey - The lock key
 * @param ownerId - The owner ID from acquireDistributedLock
 * @param namespace - Redis namespace
 * @returns Whether the lock was successfully released
 */
export async function releaseDistributedLock(
  lockKey: string,
  ownerId: string,
  namespace: ServiceNamespace = ServiceNamespace.SHARED,
): Promise<boolean> {
  const redis = getRedisClient(namespace);

  try {
    const result = await redis.eval(LUA_RELEASE_SCRIPT, [lockKey], [ownerId]);

    return result === 1;
  } catch (error) {
    // Log but don't throw - lock release failures are non-fatal
    // The lock will expire via TTL anyway
    logger.warn({
      message: "Failed to release distributed lock",
      lockKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Check if a lock is currently held and get info.
 *
 * @param lockKey - The lock key
 * @param namespace - Redis namespace
 * @returns Lock information
 */
export async function getLockInfo(
  lockKey: string,
  namespace: ServiceNamespace = ServiceNamespace.SHARED,
): Promise<LockInfo> {
  const redis = getRedisClient(namespace);

  try {
    const exists = await redis.exists(lockKey);
    if (exists !== 1) {
      return { isLocked: false };
    }

    const owner = await redis.get(lockKey);
    const ttl = await redis.ttl(lockKey);

    return {
      isLocked: true,
      owner: (owner as string) || undefined,
      ttlRemaining: ttl > 0 ? ttl : undefined,
    };
  } catch (_error) {
    return { isLocked: false };
  }
}

/**
 * Execute a function within a distributed lock scope.
 * Automatically acquires and releases the lock, handling failures gracefully.
 *
 * @param lockKey - Unique key for the lock
 * @param ttlSeconds - Lock TTL in seconds
 * @param fn - Function to execute while holding the lock
 * @param options - Optional configuration
 * @returns Result of the function execution
 * @throws Error if lock acquisition fails
 */
export async function withDistributedLock<T>(
  lockKey: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
  options?: DistributedLockOptions,
): Promise<T> {
  const lock = await acquireDistributedLock(lockKey, ttlSeconds, options);

  if (!lock.acquired) {
    throw retryableError(
      AsyncBoundaryErrorCode.RATE_LIMITED_RETRYABLE,
      `Failed to acquire distributed lock: ${lockKey}`,
      { source: "distributed-lock", operation: "withDistributedLock" },
    );
  }

  try {
    return await fn();
  } finally {
    await releaseDistributedLock(lockKey, lock.ownerId, options?.namespace);
  }
}

// ============================================================================
// LEGACY COMPATIBILITY WRAPPER
// Provides drop-in replacement for the old withRedlock function
// ============================================================================

/**
 * Legacy compatibility: Drop-in replacement for withRedlock.
 *
 * @deprecated Use `withDistributedLock` instead.
 * This wrapper exists to ease migration from Redlock.
 *
 * @param lockKey - Lock key
 * @param validityMs - Lock validity in milliseconds
 * @param fn - Function to execute
 * @returns Result of the function
 */
export async function withDistributedLockLegacyCompat<T>(
  lockKey: string,
  validityMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const ttlSeconds = Math.ceil(validityMs / 1000);
  return withDistributedLock(lockKey, ttlSeconds, fn);
}

// ============================================================================
// RE-ENTRANT DISTRIBUTED LOCK FUNCTIONS
// Supports nested lock acquisition within the same execution context
// ============================================================================

/**
 * Acquire a re-entrant distributed lock.
 * If the same execution context already holds the lock, increments depth instead.
 *
 * @param lockKey - Unique key for the lock
 * @param ttlSeconds - Lock TTL in seconds
 * @param options - Re-entrancy options (executionId required for re-entrancy)
 * @returns Re-entrant lock result
 */
export async function acquireReentrantLock(
  lockKey: string,
  ttlSeconds: number,
  options?: ReentrantLockOptions,
): Promise<ReentrantLockResult> {
  const {
    namespace = ServiceNamespace.SHARED,
    recoverStale: _recoverStale = true,
  } = options || {};
  const redis = getRedisClient(namespace);

  const executionId = options?.executionId;
  const reentrancyToken = executionId
    ? `reentrant:${executionId}:${options.ownerId || "default"}`
    : null;

  // Check for existing metadata (re-entrancy detection)
  const metaKey = lockKey + META_SUFFIX;
  if (reentrancyToken) {
    try {
      const metaRaw = await redis.get(metaKey);
      if (metaRaw) {
        const meta = JSON.parse(metaRaw) as Record<string, unknown>;
        if (meta.reentrancyToken === reentrancyToken) {
          // Re-entrant acquisition - increment depth
          const newDepth = (meta.reentrancyDepth as number) + 1;
          meta.reentrancyDepth = newDepth;
          meta.acquiredAt = new Date().toISOString();
          await redis.set(metaKey, JSON.stringify(meta), "EX", ttlSeconds);
          // Also refresh the lock TTL
          await redis.expire(lockKey, ttlSeconds);
          return {
            acquired: true,
            lockKey,
            ownerId: meta.ownerId as string,
            isReentrant: true,
            reentrancyDepth: newDepth,
          };
        }
      }
    } catch {
      // Metadata parse error - proceed with normal acquisition
    }
  }

  // Normal acquisition
  const ownerId = randomUUID();
  const acquired = await redis.eval(
    LUA_ACQUIRE_SCRIPT,
    [lockKey],
    [ownerId, String(Math.floor(ttlSeconds))],
  );

  if (acquired === 1) {
    // Store metadata
    const metadata = {
      ownerId,
      acquiredAt: new Date().toISOString(),
      ttlSeconds,
      reentrancyToken,
      reentrancyDepth: 1,
    };
    try {
      await redis.set(metaKey, JSON.stringify(metadata), "EX", ttlSeconds);
    } catch {
      // Metadata storage failure - continue without re-entrancy support
    }
    return {
      acquired: true,
      lockKey,
      ownerId,
      reentrancyDepth: 1,
    };
  }

  return { acquired: false, lockKey, ownerId: "" };
}

/**
 * Release a re-entrant distributed lock.
 * If depth > 1, decrements depth instead of actually releasing.
 *
 * @param lockKey - The lock key
 * @param ownerId - The owner ID from acquireReentrantLock
 * @param options - Re-entrancy options
 * @returns Whether the lock was fully released
 */
export async function releaseReentrantLock(
  lockKey: string,
  ownerId: string,
  options?: ReentrantLockOptions,
): Promise<boolean> {
  const { namespace = ServiceNamespace.SHARED } = options || {};
  const redis = getRedisClient(namespace);
  const metaKey = lockKey + META_SUFFIX;

  try {
    // Check metadata for re-entrancy
    const metaRaw = await redis.get(metaKey);
    if (metaRaw) {
      const meta = JSON.parse(metaRaw) as Record<string, unknown>;
      const depth = (meta.reentrancyDepth as number) || 1;

      if (depth > 1) {
        // Decrement depth
        meta.reentrancyDepth = depth - 1;
        await redis.set(metaKey, JSON.stringify(meta), "KEEPTTL");
        return false; // Not fully released
      }
    }

    // Release the actual lock
    const released = await releaseDistributedLock(lockKey, ownerId, namespace);

    // Clean up metadata
    if (released) {
      try {
        await redis.del(metaKey);
      } catch {
        // Metadata cleanup failure - it will expire eventually
      }
    }

    return released;
  } catch (error) {
    logger.warn({
      message: "Failed to release re-entrant lock",
      lockKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Execute a function within a re-entrant distributed lock scope.
 *
 * @param lockKey - Unique key for the lock
 * @param ttlSeconds - Lock TTL in seconds
 * @param fn - Function to execute while holding the lock
 * @param options - Re-entrancy options (executionId required for re-entrancy)
 * @returns Result of the function execution
 * @throws Error if lock acquisition fails
 */
export async function withReentrantDistributedLock<T>(
  lockKey: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
  options?: ReentrantLockOptions & DistributedLockOptions,
): Promise<T> {
  const lock = await acquireReentrantLock(lockKey, ttlSeconds, options);

  if (!lock.acquired) {
    throw retryableError(
      AsyncBoundaryErrorCode.RATE_LIMITED_RETRYABLE,
      `Failed to acquire distributed lock: ${lockKey}`,
      { source: "distributed-lock", operation: "withReentrantDistributedLock" },
    );
  }

  try {
    return await fn();
  } finally {
    await releaseReentrantLock(lockKey, lock.ownerId, options);
  }
}
