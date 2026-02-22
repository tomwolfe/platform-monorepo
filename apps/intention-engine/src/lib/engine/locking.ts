/**
 * Enhanced Locking Service with Deadlock Prevention
 *
 * Features:
 * - Automatic lock expiration (TTL-based)
 * - Lock ownership tracking for debugging
 * - Deadlock detection via lock age monitoring
 * - Automatic recovery for stale locks
 * - Lock acquisition telemetry
 *
 * Usage:
 * ```typescript
 * const lock = await LockingService.acquireLock('exec:my-id:lock', { ttlSeconds: 30 });
 * if (lock.acquired) {
 *   try {
 *     // do work
 *   } finally {
 *     await lock.release();
 *   }
 * }
 * ```
 */

import { redis } from "@/lib/redis-client";
import { randomUUID } from "crypto";

export interface LockMetadata {
  ownerId: string;
  acquiredAt: string;
  ttlSeconds: number;
  operation?: string;
  traceId?: string;
}

export interface LockResult {
  acquired: boolean;
  lockKey: string;
  metadata?: LockMetadata;
  error?: string;
  wasStale?: boolean;
}

export class Lock {
  private lockKey: string;
  private ownerId: string;
  private lockMetadata: LockMetadata;
  private released = false;

  constructor(lockKey: string, ownerId: string, metadata: LockMetadata) {
    this.lockKey = lockKey;
    this.ownerId = ownerId;
    this.lockMetadata = metadata;
  }

  /**
   * Release the lock
   * Only the owner can release the lock
   */
  async release(): Promise<boolean> {
    if (this.released) {
      return false;
    }

    const currentOwner = await redis.get(this.lockKey);
    if ((currentOwner as string) !== this.ownerId) {
      console.warn(
        `[Lock] Cannot release ${this.lockKey}: owner mismatch (expected ${this.ownerId}, got ${currentOwner})`
      );
      return false;
    }

    await redis.del(this.lockKey);
    this.released = true;

    console.log(`[Lock] Released ${this.lockKey} (owner: ${this.ownerId})`);
    return true;
  }

  /**
   * Extend the lock TTL
   * Only the owner can extend the lock
   */
  async extend(ttlSeconds: number): Promise<boolean> {
    const currentOwner = await redis.get(this.lockKey);
    if ((currentOwner as string) !== this.ownerId) {
      console.warn(
        `[Lock] Cannot extend ${this.lockKey}: owner mismatch`
      );
      return false;
    }

    await redis.expire(this.lockKey, ttlSeconds);
    this.lockMetadata.ttlSeconds = ttlSeconds;

    console.log(`[Lock] Extended ${this.lockKey} to ${ttlSeconds}s`);
    return true;
  }

  /**
   * Check if this lock instance still holds the lock
   */
  async isStillOwner(): Promise<boolean> {
    const currentOwner = await redis.get(this.lockKey);
    return (currentOwner as string) === this.ownerId;
  }

  get metadata(): LockMetadata {
    return { ...this.lockMetadata };
  }

  get isReleased(): boolean {
    return this.released;
  }
}

export namespace LockingService {
  /**
   * Acquire a lock with deadlock prevention
   *
   * Features:
   * - Unique owner ID for each acquisition attempt
   * - Metadata stored alongside lock for debugging
   * - Automatic stale lock recovery
   * - TTL-based expiration (prevents permanent deadlocks)
   */
  export async function acquireLock(
    lockKey: string,
    options?: {
      ttlSeconds?: number;
      operation?: string;
      traceId?: string;
      recoverStale?: boolean;
    }
  ): Promise<LockResult> {
    const {
      ttlSeconds = 30,
      operation,
      traceId,
      recoverStale = true,
    } = options || {};

    const ownerId = randomUUID();
    const metadata: LockMetadata = {
      ownerId,
      acquiredAt: new Date().toISOString(),
      ttlSeconds,
      operation,
      traceId,
    };

    try {
      // Check if lock exists and might be stale
      if (recoverStale) {
        const existingLock = await redis.get(lockKey);
        if (existingLock) {
          const metadataKey = `${lockKey}:meta`;
          const existingMetadata = await redis.get(metadataKey);

          if (existingMetadata) {
            const parsed = JSON.parse(existingMetadata as string) as LockMetadata;
            const age = Date.now() - new Date(parsed.acquiredAt).getTime();
            const ageSeconds = age / 1000;

            // If lock is older than TTL + buffer, it's stale - force delete
            if (ageSeconds > ttlSeconds + 10) {
              console.warn(
                `[Lock] Recovering stale lock ${lockKey} (age: ${ageSeconds.toFixed(0)}s, TTL: ${ttlSeconds}s)`
              );
              await redis.del(lockKey);
              await redis.del(metadataKey);
            }
          }
        }
      }

      // Try to acquire lock with SETNX
      const acquired = await redis.set(lockKey, ownerId, {
        nx: true,
        ex: ttlSeconds,
      });

      if (acquired === "OK") {
        // Store metadata for debugging
        const metadataKey = `${lockKey}:meta`;
        await redis.setex(metadataKey, ttlSeconds, JSON.stringify(metadata));

        console.log(
          `[Lock] Acquired ${lockKey} (owner: ${ownerId.slice(0, 8)}..., TTL: ${ttlSeconds}s)`
        );

        return {
          acquired: true,
          lockKey,
          metadata,
        };
      }

      // Lock already held - return info about current holder
      const currentOwner = await redis.get(lockKey);
      const metadataKey = `${lockKey}:meta`;
      const currentMetadata = await redis.get(metadataKey);

      return {
        acquired: false,
        lockKey,
        metadata: currentMetadata ? JSON.parse(currentMetadata as string) : undefined,
        error: `Lock held by ${(currentOwner as string)?.slice(0, 8)}...`,
      };
    } catch (error) {
      console.error(`[Lock] Failed to acquire ${lockKey}:`, error);
      return {
        acquired: false,
        lockKey,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Acquire a lock and return a Lock instance for management
   *
   * @example
   * ```typescript
   * const lock = await LockingService.acquire('exec:123:lock', { ttlSeconds: 30 });
   * if (lock) {
   *   try {
   *     // do work
   *     await lock.extend(60); // extend if needed
   *   } finally {
   *     await lock.release();
   *   }
   * }
   * ```
   */
  export async function acquire(
    lockKey: string,
    options?: {
      ttlSeconds?: number;
      operation?: string;
      traceId?: string;
    }
  ): Promise<Lock | null> {
    const result = await acquireLock(lockKey, options);

    if (!result.acquired || !result.metadata) {
      return null;
    }

    return new Lock(lockKey, result.metadata.ownerId, result.metadata);
  }

  /**
   * Release a lock
   * Only works if the caller is the lock owner
   */
  export async function releaseLock(
    lockKey: string,
    expectedOwner?: string
  ): Promise<boolean> {
    if (!expectedOwner) {
      // Simple release without owner check (legacy behavior)
      await redis.del(lockKey);
      await redis.del(`${lockKey}:meta`);
      return true;
    }

    const currentOwner = await redis.get(lockKey);
    if ((currentOwner as string) !== expectedOwner) {
      console.warn(
        `[Lock] Cannot release ${lockKey}: owner mismatch (expected ${expectedOwner.slice(0, 8)}..., got ${(currentOwner as string)?.slice(0, 8)}...)`
      );
      return false;
    }

    await redis.del(lockKey);
    await redis.del(`${lockKey}:meta`);

    console.log(`[Lock] Released ${lockKey} (owner: ${expectedOwner.slice(0, 8)}...)`);
    return true;
  }

  /**
   * Check if a lock is currently held
   */
  export async function isLocked(lockKey: string): Promise<boolean> {
    const exists = await redis.exists(lockKey);
    return exists === 1;
  }

  /**
   * Get lock metadata (owner, age, etc.)
   */
  export async function getLockInfo(lockKey: string): Promise<{
    isLocked: boolean;
    owner?: string;
    ageSeconds?: number;
    ttlSeconds?: number;
    metadata?: LockMetadata;
  } | null> {
    const exists = await redis.exists(lockKey);
    if (exists !== 1) {
      return { isLocked: false };
    }

    const owner = await redis.get(lockKey);
    const metadataKey = `${lockKey}:meta`;
    const metadataStr = await redis.get(metadataKey);
    const metadata = metadataStr ? (JSON.parse(metadataStr as string) as LockMetadata) : undefined;

    const ttl = await redis.ttl(lockKey);
    const ageSeconds = metadata
      ? (Date.now() - new Date(metadata.acquiredAt).getTime()) / 1000
      : undefined;

    return {
      isLocked: true,
      owner: owner as string,
      ageSeconds,
      ttlSeconds: ttl > 0 ? ttl : undefined,
      metadata,
    };
  }

  /**
   * Detect potentially deadlocked locks
   * Returns locks that are older than their TTL
   */
  export async function detectDeadlocks(
    pattern = "exec:*:lock"
  ): Promise<Array<{ key: string; info: NonNullable<Awaited<ReturnType<typeof getLockInfo>>> }>> {
    const keys = await redis.keys(pattern);
    const deadlocks: Array<{ key: string; info: NonNullable<Awaited<ReturnType<typeof getLockInfo>>> }> = [];

    for (const key of keys) {
      const info = await getLockInfo(key);
      if (info && info.isLocked && info.metadata) {
        const ageSeconds = info.ageSeconds || 0;
        const ttlSeconds = info.ttlSeconds || info.metadata.ttlSeconds;

        if (ageSeconds > ttlSeconds) {
          deadlocks.push({ key, info });
        }
      }
    }

    if (deadlocks.length > 0) {
      console.warn(
        `[Lock] Detected ${deadlocks.length} potentially deadlocked lock(s):`,
        deadlocks.map(d => ({
          key: d.key,
          age: d.info.ageSeconds?.toFixed(0),
          ttl: d.info.ttlSeconds,
          owner: d.info.owner?.slice(0, 8),
        }))
      );
    }

    return deadlocks;
  }

  /**
   * Recover deadlocked locks by deleting them
   */
  export async function recoverDeadlocks(
    pattern = "exec:*:lock"
  ): Promise<number> {
    const deadlocks = await detectDeadlocks(pattern);
    let recovered = 0;

    for (const { key } of deadlocks) {
      await redis.del(key);
      await redis.del(`${key}:meta`);
      recovered++;
    }

    if (recovered > 0) {
      console.log(`[Lock] Recovered ${recovered} deadlocked lock(s)`);
    }

    return recovered;
  }

  /**
   * Acquire step idempotency lock
   * Prevents double execution of the same step
   */
  export async function acquireStepIdempotencyLock(
    executionId: string,
    stepIndex: number,
    ttlSeconds: number = 3600
  ): Promise<LockResult> {
    const lockKey = `exec:${executionId}:step:${stepIndex}:lock`;
    return acquireLock(lockKey, {
      ttlSeconds,
      operation: `step:${stepIndex}`,
      recoverStale: true,
    });
  }

  /**
   * Health check - verify locking system is operational
   */
  export async function healthCheck(): Promise<{
    healthy: boolean;
    redisConnected: boolean;
    deadlocksDetected: number;
    error?: string;
  }> {
    try {
      // Check Redis connectivity
      await redis.ping();
      const redisConnected = true;

      // Check for deadlocks
      const deadlocks = await detectDeadlocks();

      return {
        healthy: deadlocks.length === 0,
        redisConnected,
        deadlocksDetected: deadlocks.length,
      };
    } catch (error) {
      return {
        healthy: false,
        redisConnected: false,
        deadlocksDetected: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
