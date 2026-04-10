/**
 * Global Replay Guard Middleware
 *
 * Purpose: Prevent replay attacks across all Web3-enabled services
 *
 * Problem Solved: Cross-Service Replay Vulnerability
 * - Without a unified check, an attacker could use one transaction hash to "pay" for multiple services
 * - Example: Use the same txHash to pay for both a reservation (table-stack) and delivery (open-delivery)
 *
 * Solution: Universal Replay Guard
 * - Single source of truth: processed_crypto_transactions table
 * - Check BEFORE any tool logic is initialized
 * - Works for both open-delivery and table-stack
 * - Returns explicit error with details about original processing
 * - IP-based rate limiting and fraud detection (5 attempts/minute → 1hr ban)
 *
 * Usage in API routes:
 * ```typescript
 * // At the start of your API route handler
 * const replayGuard = await checkReplayPrevention({
 *   txHash: '0x...',
 *   appSource: 'open-delivery', // or 'table-stack'
 * });
 *
 * if (!replayGuard.allowed) {
 *   return NextResponse.json({ error: replayGuard.error }, { status: 409 });
 * }
 *
 * // Continue with tool logic...
 * ```
 *
 * Usage in Tools/Middleware:
 * ```typescript
 * // Before executing any crypto-related tool
 * const guard = await createReplayGuardMiddleware();
 * const result = await guard.check(txHash, 'open-delivery');
 *
 * if (!result.allowed) {
 *   throw new Error(`Transaction already processed: ${result.error}`);
 * }
 * ```
 *
 * @package @repo/shared
 */

import { getDb, processed_crypto_transactions, eq } from "@repo/database";
import type { Hash } from "viem";
import { getRedisClient, ServiceNamespace } from "../redis";
import { Logger } from "../logger";
import { CACHE_TIERS } from "../config/cache-tiers";

const replayLogger = new Logger({ serviceName: "replay-guard" });

// ============================================================================
// CONSTANTS
// ============================================================================

const REPLAY_ATTEMPT_WINDOW_SECONDS = 60; // 1 minute window for attempt tracking
const MAX_REPLAY_ATTEMPTS = 5; // Max attempts before IP ban
const IP_BAN_DURATION_SECONDS = 3600; // 1 hour IP ban
const REPLAY_ATTEMPT_KEY_PREFIX = "replay_attempts";
const IP_BAN_KEY_PREFIX = "ip_banned";

// ============================================================================
// TYPES
// ============================================================================

export interface ReplayGuardCheck {
  /** Transaction hash to check */
  txHash: Hash;
  /** Source app making the check ('open-delivery' | 'table-stack') */
  appSource: string;
  /** Optional entity ID for additional context */
  entityId?: string;
  /** Optional IP address for rate limiting and fraud detection */
  ipAddress?: string;
}

export interface ReplayGuardResult {
  /** Whether the transaction is allowed to proceed */
  allowed: boolean;
  /** Error message if not allowed */
  error?: string;
  /** Details about the original processing if found */
  existingTransaction?: {
    txHash: string;
    appSource: string;
    entityId: string;
    createdAt: Date;
  };
  /** Whether this request appears suspicious (multiple replay attempts) */
  isSuspicious?: boolean;
  /** Number of replay attempts detected from this IP */
  replayAttemptCount?: number;
  /** Whether the IP is currently banned */
  isIpBanned?: boolean;
}

export interface ReplayGuardMiddleware {
  /**
   * Atomically check if a transaction is allowed and register it (TOCTOU-safe)
   * This combines check + register into a single atomic operation
   */
  check(params: ReplayGuardCheck): Promise<ReplayGuardResult>;
}

// ============================================================================
// REPLAY GUARD MIDDLEWARE
// ============================================================================

export class ReplayGuardService implements ReplayGuardMiddleware {
  private db: ReturnType<typeof getDb>;
  private redis: ReturnType<typeof getRedisClient>;

  constructor() {
    this.db = getDb();
    this.redis = getRedisClient(ServiceNamespace.SHARED);
  }

  /**
   * Redis key for a processed transaction hash (used for fast middleware pre-checks)
   * Value is "1", expiration is 24 hours (86400 seconds)
   */
  private getRedisKey(txHash: string): string {
    return `replay_guard:${txHash}`;
  }

  /**
   * Redis key for a processing transaction hash (two-phase commit lock)
   * Value is "processing", expiration is 120 seconds (prevents permanent deadlocks on lambda crash)
   */
  private getProcessingKey(txHash: string): string {
    return `replay_guard:processing:${txHash}`;
  }

  /**
   * Redis key for replay attempt tracking
   * Format: replay_attempts:{txHash}:{ipAddress}
   */
  private getReplayAttemptKey(txHash: string, ipAddress: string): string {
    return `${REPLAY_ATTEMPT_KEY_PREFIX}:${txHash}:${ipAddress}`;
  }

  /**
   * Redis key for IP ban tracking
   */
  private getIpBanKey(ipAddress: string): string {
    return `${IP_BAN_KEY_PREFIX}:${ipAddress}`;
  }

  /**
   * Check if an IP address is currently banned
   */
  async isIpBanned(ipAddress: string): Promise<boolean> {
    try {
      const banned = await this.redis.exists(this.getIpBanKey(ipAddress));
      return banned === 1;
    } catch (error) {
      replayLogger.warn(
        "[ReplayGuard] Redis unavailable for IP ban check:",
        error,
      );
      return false; // Fail open - allow request if Redis is down
    }
  }

  /**
   * Ban an IP address temporarily
   */
  private async banIp(ipAddress: string): Promise<void> {
    try {
      await this.redis.setex(
        this.getIpBanKey(ipAddress),
        IP_BAN_DURATION_SECONDS,
        "1",
      );
      replayLogger.warn({
        message: "[ReplayGuard] IP address banned",
        ipAddress,
        banDurationSeconds: IP_BAN_DURATION_SECONDS,
      });
    } catch (error) {
      replayLogger.error("[ReplayGuard] Failed to ban IP address:", error);
    }
  }

  /**
   * Increment replay attempt counter and check if threshold exceeded
   */
  private async trackReplayAttempt(
    txHash: string,
    ipAddress: string,
  ): Promise<{ attemptCount: number; shouldBan: boolean }> {
    const key = this.getReplayAttemptKey(txHash, ipAddress);

    try {
      // Atomic increment with TTL
      const LuaIncrementScript = `
        local key = KEYS[1]
        local count = redis.call("INCR", key)
        if count == 1 then
          redis.call("EXPIRE", key, tonumber(ARGV[1]))
        end
        return count
      `;

      const attemptCount = await this.redis.eval(
        LuaIncrementScript,
        [key],
        [String(REPLAY_ATTEMPT_WINDOW_SECONDS)],
      );

      const count = Number(attemptCount);
      const shouldBan = count >= MAX_REPLAY_ATTEMPTS;

      if (shouldBan) {
        await this.banIp(ipAddress);
      }

      return { attemptCount: count, shouldBan };
    } catch (error) {
      replayLogger.error(
        "[ReplayGuard] Failed to track replay attempt:",
        error,
      );
      return { attemptCount: 0, shouldBan: false };
    }
  }

  /**
   * Write a processed txHash to Redis with 24h expiration (for middleware pre-checks)
   */
  private async cacheTxHashInRedis(txHash: string): Promise<void> {
    try {
      await this.redis.setex(this.getRedisKey(txHash), 86400, "1");
    } catch (error) {
      // Log but don't fail - Redis cache failure is non-critical
      replayLogger.warn({ message: "Failed to cache txHash in Redis", error });
    }
  }

  /**
   * Check if a txHash exists in Redis (fast pre-check for middleware)
   */
  async existsInRedis(txHash: string): Promise<boolean> {
    try {
      const exists = await this.redis.exists(this.getRedisKey(txHash));
      return exists === 1;
    } catch (error) {
      // If Redis is unavailable, return false to fall through to route handler
      replayLogger.warn({ message: "Redis unavailable for pre-check", error });
      return false;
    }
  }

  /**
   * Check if a transaction has already been processed (globally across all apps)
   *
   * ATOMIC INSERT-FIRST PATTERN (TOCTOU-safe):
   * Instead of SELECT-then-INSERT (which has a race condition), we INSERT first.
   * If the insert fails due to a unique constraint violation, the tx was already
   * processed by a concurrent request - this is a replay attack attempt.
   *
   * This prevents an attacker from reusing a transaction hash to pay for multiple services
   * by eliminating the window between check and registration.
   *
   * @param params - Check parameters (entityId is REQUIRED for atomic registration)
   * @returns Result indicating if transaction is allowed to proceed
   */
  async check(params: ReplayGuardCheck): Promise<ReplayGuardResult> {
    const { txHash, appSource, entityId, ipAddress } = params;

    if (!entityId) {
      return {
        allowed: false,
        error: "entityId is required for atomic replay guard check",
      };
    }

    // FRAUD DETECTION: Check if IP is banned
    if (ipAddress) {
      const banned = await this.isIpBanned(ipAddress);
      if (banned) {
        replayLogger.warn({
          message: "[ReplayGuard] Blocked request from banned IP",
          ipAddress,
          txHash,
          appSource,
        });
        return {
          allowed: false,
          error:
            "Request blocked: IP address is temporarily banned due to suspicious activity",
          isIpBanned: true,
        };
      }
    }

    try {
      // ATOMIC INSERT: Try to register the transaction first
      // This eliminates the TOCTOU race condition
      await this.db.insert(processed_crypto_transactions).values({
        txHash,
        appSource,
        entityId,
      });

      // Insert succeeded - transaction is now registered and allowed to proceed
      replayLogger.info({
        message: "Atomically registered transaction",
        txHashPrefix: txHash.substring(0, 10),
        appSource,
        entityId,
      });

      // Cache in Redis for fast middleware pre-checks (24h expiration)
      await this.cacheTxHashInRedis(txHash);

      return {
        allowed: true,
      };
    } catch (error) {
      // Check if this is a duplicate key error (replay attack attempt)
      const isDuplicateError =
        error instanceof Error &&
        (error.message.includes("duplicate key") ||
          error.message.includes("unique constraint") ||
          error.message.includes("23505")); // Postgres unique violation SQLSTATE

      if (isDuplicateError) {
        // FRAUD DETECTION: Track replay attempt if IP is provided
        let attemptCount = 0;
        let shouldBan = false;

        if (ipAddress) {
          const attemptResult = await this.trackReplayAttempt(
            txHash,
            ipAddress,
          );
          attemptCount = attemptResult.attemptCount;
          shouldBan = attemptResult.shouldBan;

          if (attemptCount >= 2) {
            // Log as potential fraud indicator
            replayLogger.warn({
              message:
                "[ReplayGuard] Multiple replay attempts detected - potential fraud",
              ipAddress,
              txHash,
              appSource,
              attemptCount,
              shouldBan,
            });
          }
        }

        // Transaction already exists - look it up to provide details
        try {
          const existingTx =
            await this.db.query.processed_crypto_transactions.findFirst({
              where: eq(processed_crypto_transactions.txHash, txHash),
            });

          return {
            allowed: false,
            error: `Transaction already processed by ${existingTx?.appSource ?? "unknown"} for entity ${existingTx?.entityId ?? "unknown"} on ${existingTx?.createdAt?.toISOString() ?? "unknown"}`,
            existingTransaction: existingTx
              ? {
                  txHash: existingTx.txHash,
                  appSource: existingTx.appSource,
                  entityId: existingTx.entityId,
                  createdAt: existingTx.createdAt,
                }
              : undefined,
            isSuspicious: attemptCount >= 2,
            replayAttemptCount: attemptCount,
            isIpBanned: shouldBan,
          };
        } catch (_lookupError) {
          // Fallback if lookup fails - still block as replay
          return {
            allowed: false,
            error: `Transaction already processed (replay detected)`,
            isSuspicious: attemptCount >= 2,
            replayAttemptCount: attemptCount,
            isIpBanned: shouldBan,
          };
        }
      }

      // Other database error - fail-closed to prevent potential replay
      replayLogger.error({
        message: "Database error during atomic replay check",
        error,
      });
      return {
        allowed: false,
        error: `Replay guard check failed: ${error instanceof Error ? error.message : "Unknown database error"}`,
      };
    }
  }

  /**
   * Bulk check multiple transactions (for batch operations)
   *
   * @param checks - Array of check parameters
   * @returns Array of results in same order as input
   */
  async checkBatch(checks: ReplayGuardCheck[]): Promise<ReplayGuardResult[]> {
    const results: ReplayGuardResult[] = [];

    for (const check of checks) {
      const result = await this.check(check);
      results.push(result);
    }

    return results;
  }

  /**
   * Rollback a previously registered transaction hash
   *
   * COMPENSATING ACTION: If business logic fails AFTER the replay guard
   * has been triggered (INSERT succeeded), this removes the registration
   * so the user can re-submit their valid payment without it being flagged
   * as a replay attack.
   *
   * This is safe because:
   * - The transaction was never actually processed on-chain
   * - No side effects occurred (order was not created)
   * - The user's payment is still valid and unspent
   *
   * @param txHash - Transaction hash to rollback
   */
  async rollback(txHash: Hash): Promise<void> {
    try {
      await this.db
        .delete(processed_crypto_transactions)
        .where(eq(processed_crypto_transactions.txHash, txHash));

      replayLogger.info({
        message: "Rolled back transaction",
        txHashPrefix: txHash.substring(0, 10),
      });
    } catch (error) {
      // Log but don't throw - rollback failure is non-fatal
      replayLogger.error({
        message: "Failed to rollback transaction",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * TWO-PHASE COMMIT: Try to acquire a processing lock with short TTL
   *
   * PHASE 1 (Claim): Register the txHash in Redis with "processing" status and 120s TTL.
   * If the key already exists, the transaction is already being processed (duplicate).
   *
   * This prevents the "bricked transaction hash" problem:
   * - If the lambda crashes AFTER this check but BEFORE DB commit,
   *   the 120s TTL automatically releases the lock.
   * - The user can retry after the TTL expires.
   *
   * @param txHash - Transaction hash to lock
   * @returns true if lock was acquired, false if already processing/processed
   */
  async tryAcquireProcessingLock(txHash: Hash): Promise<boolean> {
    try {
      const processingKey = this.getProcessingKey(txHash);
      const set = await this.redis.set(processingKey, "processing", {
        nx: true, // Only set if key does NOT exist
        ex: 15, // SERVERLESS FIX: 15s TTL (prevents deadlocks on lambda crash, was 120s)
      });

      if (set === null) {
        // Key already exists - another request is processing this txHash
        return false;
      }

      return true;
    } catch (error) {
      replayLogger.error(
        "[ReplayGuard] Failed to acquire processing lock:",
        error,
      );
      // Fail open - allow processing if Redis is down
      return true;
    }
  }

  /**
   * TWO-PHASE COMMIT: Confirm a processing transaction (upgrade to "confirmed")
   *
   * PHASE 2 (Commit): After successful on-chain verification and DB transaction,
   * upgrade the Redis status from "processing" to "confirmed" with a 24h TTL.
   *
   * This should be called INSIDE or immediately after the DB transaction succeeds.
   * If the lambda crashes before this call, the 120s TTL from Phase 1 will
   * automatically release the lock.
   *
   * @param txHash - Transaction hash to confirm
   */
  async confirmTransaction(txHash: Hash): Promise<void> {
    try {
      const processingKey = this.getProcessingKey(txHash);
      const confirmedKey = this.getRedisKey(txHash);

      // Upgrade to confirmed with 24h TTL
      await this.redis.set(confirmedKey, "1", { ex: CACHE_TIERS.EXTENDED });

      // Remove the processing lock
      await this.redis.del(processingKey);
    } catch (error) {
      // Log but don't fail - Redis cache failure is non-critical
      // The DB record is the source of truth
      replayLogger.warn(
        "[ReplayGuard] Failed to confirm transaction in Redis:",
        error,
      );
    }
  }

  /**
   * TWO-PHASE COMMIT: Release a processing lock early
   *
   * SAFETY: If transaction verification fails BEFORE the DB commit,
   * this releases the processing lock so the user can retry immediately
   * without waiting for the 120s TTL to expire.
   *
   * This is idempotent — safe to call even if the key was already removed.
   *
   * @param txHash - Transaction hash to unlock
   */
  async releaseProcessingLock(txHash: Hash): Promise<void> {
    try {
      const processingKey = this.getProcessingKey(txHash);
      await this.redis.del(processingKey);
    } catch (error) {
      // Log but don't fail — lock release failure is non-critical
      // since the 120s TTL will auto-expire the key.
      replayLogger.warn(
        "[ReplayGuard] Failed to release processing lock:",
        error,
      );
    }
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

let defaultReplayGuard: ReplayGuardService | null = null;

/**
 * Get or create the default ReplayGuard instance
 *
 * @returns Singleton ReplayGuard instance
 */
export function getReplayGuard(): ReplayGuardService {
  if (!defaultReplayGuard) {
    defaultReplayGuard = new ReplayGuardService();
  }
  return defaultReplayGuard;
}

/**
 * Create a new ReplayGuard instance
 *
 * Useful for testing or when you need multiple instances
 *
 * @returns New ReplayGuard instance
 */
export function createReplayGuard(): ReplayGuardService {
  return new ReplayGuardService();
}

// ============================================================================
// MIDDLEWARE HELPER FUNCTIONS
// ============================================================================

/**
 * Quick Redis pre-check for Edge Middleware (fast, no DB bundle)
 *
 * Usage in Next.js middleware.ts:
 * ```typescript
 * import { isReplayBlockedInRedis } from '@repo/shared/middleware/web3-replay-guard';
 *
 * if (isCryptoPaymentRoute(req)) {
 *   const txHash = request.headers.get('x-tx-hash');
 *   if (txHash && await isReplayBlockedInRedis(txHash)) {
 *     return NextResponse.json({ error: 'Transaction already processed' }, { status: 409 });
 *   }
 * }
 * ```
 *
 * @param txHash - Transaction hash to check
 * @returns true if the transaction was already processed (should block), false otherwise
 */
export async function isReplayBlockedInRedis(txHash: string): Promise<boolean> {
  const guard = getReplayGuard();
  return guard.existsInRedis(txHash);
}

/**
 * Create replay guard middleware for API routes
 *
 * Usage:
 * ```typescript
 * export async function POST(req: NextRequest) {
 *   const guard = await createReplayGuardMiddleware();
 *
 *   // Check before processing
 *   const result = await guard.check({
 *     txHash: '0x...',
 *     appSource: 'open-delivery',
 *     entityId: orderId,
 *   });
 *
 *   if (!result.allowed) {
 *     return NextResponse.json({ error: result.error }, { status: 409 });
 *   }
 *
 *   // Continue with processing...
 * }
 * ```
 */
export async function createReplayGuardMiddleware(): Promise<ReplayGuardMiddleware> {
  return getReplayGuard();
}

/**
 * Quick check helper - returns true if transaction is allowed
 *
 * NOTE: This atomically registers the transaction if allowed.
 * Do NOT call registerTransaction after this - it's already done.
 *
 * Usage:
 * ```typescript
 * const allowed = await isReplayAllowed({
 *   txHash: '0x...',
 *   appSource: 'table-stack',
 *   entityId: orderId, // REQUIRED for atomic registration
 * });
 *
 * if (!allowed) {
 *   throw new Error('Transaction already processed');
 * }
 * // Continue processing - transaction is already registered
 * ```
 */
export async function isReplayAllowed(
  params: ReplayGuardCheck,
): Promise<boolean> {
  const guard = getReplayGuard();
  const result = await guard.check(params);
  return result.allowed;
}

/**
 * Rollback a previously registered transaction hash
 *
 * Convenience wrapper around ReplayGuardService.rollback()
 *
 * @param txHash - Transaction hash to rollback
 */
export async function rollbackReplayGuard(txHash: Hash): Promise<void> {
  const guard = getReplayGuard();
  await guard.rollback(txHash);
}

/**
 * TWO-PHASE COMMIT: Try to acquire a processing lock with short TTL
 *
 * PHASE 1 (Claim): Register the txHash in Redis with "processing" status and 120s TTL.
 * If the key already exists, the transaction is already being processed (duplicate).
 *
 * Convenience wrapper around ReplayGuardService.tryAcquireProcessingLock()
 *
 * @param txHash - Transaction hash to lock
 * @returns true if lock was acquired, false if already processing/processed
 */
export async function tryAcquireReplayProcessingLock(
  txHash: Hash,
): Promise<boolean> {
  const guard = getReplayGuard();
  return guard.tryAcquireProcessingLock(txHash);
}

/**
 * TWO-PHASE COMMIT: Confirm a processing transaction (upgrade to "confirmed")
 *
 * PHASE 2 (Commit): After successful on-chain verification and DB transaction,
 * upgrade the Redis status from "processing" to "confirmed" with a 24h TTL.
 *
 * Convenience wrapper around ReplayGuardService.confirmTransaction()
 *
 * @param txHash - Transaction hash to confirm
 */
export async function confirmReplayGuard(txHash: Hash): Promise<void> {
  const guard = getReplayGuard();
  await guard.confirmTransaction(txHash);
}

/**
 * TWO-PHASE COMMIT: Release a processing lock early
 *
 * SAFETY: If transaction verification fails BEFORE the DB commit,
 * this releases the processing lock so the user can retry immediately
 * without waiting for the 120s TTL to expire.
 *
 * Convenience wrapper around ReplayGuardService.releaseProcessingLock()
 *
 * @param txHash - Transaction hash to unlock
 */
export async function releaseReplayProcessingLock(txHash: Hash): Promise<void> {
  const guard = getReplayGuard();
  await guard.releaseProcessingLock(txHash);
}

// ============================================================================
// NEXT.JS MIDDLEWARE INTEGRATION (OPTIONAL)
// ============================================================================

/**
 * Next.js middleware wrapper for replay guard
 *
 * This can be used in apps/open-delivery/middleware.ts or apps/table-stack/middleware.ts
 * to automatically check replay prevention for specific routes.
 *
 * Example usage in middleware.ts:
 * ```typescript
 * import { NextResponse } from 'next/server';
 * import type { NextRequest } from 'next/server';
 * import { createReplayGuardForMiddleware } from '@repo/shared/middleware/web3-replay-guard';
 *
 * export async function middleware(request: NextRequest) {
 *   // Only check crypto payment routes
 *   if (request.nextUrl.pathname.startsWith('/api/checkout')) {
 *     const guard = await createReplayGuardForMiddleware();
 *     const txHash = request.headers.get('x-tx-hash');
 *
 *     if (txHash) {
 *       const result = await guard.check({
 *         txHash: txHash as Hash,
 *         appSource: 'open-delivery',
 *       });
 *
 *       if (!result.allowed) {
 *         return NextResponse.json(
 *           { error: result.error },
 *           { status: 409 }
 *         );
 *       }
 *     }
 *   }
 *
 *   return NextResponse.next();
 * }
 * ```
 */
export async function createReplayGuardForMiddleware(): Promise<ReplayGuardMiddleware> {
  return getReplayGuard();
}
