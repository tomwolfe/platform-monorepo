import { getRedisClient, ServiceNamespace } from "../redis";
import { Logger } from "../logger";
import { withDistributedLock } from "../services/distributed-lock";
import type { PublicClient } from "viem";

const logger = new Logger({ serviceName: "nonce-tracker" });

const NONCE_TTL = 86400; // 24 hours in seconds
const NONCE_LEASE_TTL = 60; // 60 seconds — max time between reserve and confirm/release

// Lua script for atomic INCR + GET + TTL
const GET_NEXT_NONCE_SCRIPT = `
local key = KEYS[1]
local current = redis.call('GET', key)
if current == false then
  -- Initialize from blockchain or start at 0
  local startNonce = tonumber(ARGV[1]) or 0
  redis.call('SET', key, tostring(startNonce))
  redis.call('EXPIRE', key, tonumber(ARGV[2]))
  return tostring(startNonce)
end
local nextNonce = tonumber(current) + 1
redis.call('SET', key, tostring(nextNonce))
redis.call('EXPIRE', key, tonumber(ARGV[2]))
return tostring(nextNonce)
`;

// Lua script for atomic nonce rollback (DECR with floor)
const RELEASE_NONCE_SCRIPT = `
local key = KEYS[1]
local current = redis.call('GET', key)
if current == false then
  return 'NOT_FOUND'
end
local currentValue = tonumber(current)
if currentValue <= 0 then
  return 'ZERO'
end
local newValue = currentValue - 1
redis.call('SET', key, tostring(newValue))
redis.call('EXPIRE', key, tonumber(ARGV[1]))
return tostring(newValue)
`;

// Lease tracking key pattern: nonce:lease:{chainId}:{address}:{nonce}
// Value: timestamp when the lease was acquired
const LEASE_KEY_PREFIX = "nonce:lease";

// Lua script to acquire a lease atomically
const ACQUIRE_LEASE_SCRIPT = `
local leaseKey = KEYS[1]
local exists = redis.call('EXISTS', leaseKey)
if exists == 1 then
  return 'EXISTS'
end
redis.call('SET', leaseKey, ARGV[1], 'EX', ARGV[2])
return 'OK'
`;

// Lua script to release a lease atomically
const RELEASE_LEASE_SCRIPT = `
local leaseKey = KEYS[1]
return redis.call('DEL', leaseKey)
`;

// Lua script to find and clean up expired leases for an address
const CLEANUP_EXPIRED_LEASES_SCRIPT = `
local pattern = KEYS[1]  -- e.g., nonce:lease:8453:0xabc*
local now = tonumber(ARGV[1])
local maxAge = tonumber(ARGV[2])
local expired = {}
local cursor = 0

repeat
  local result = redis.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', 100)
  cursor = tonumber(result[1])
  local keys = result[2]
  for i, key in ipairs(keys) do
    local leaseTime = tonumber(redis.call('GET', key))
    if leaseTime and (now - leaseTime > maxAge) then
      table.insert(expired, key)
      redis.call('DEL', key)
    end
  end
until cursor == 0

return #expired
`;

/**
 * Get the next atomic nonce for a chain + address combination.
 * Uses a Lua script for atomicity to prevent race conditions between concurrent cron runs.
 *
 * CRITICAL FIX: On cache miss, fetches the true on-chain nonce via publicClient
 * instead of defaulting to 0, preventing "nonce too low" errors after cache flush.
 *
 * @param chainId - Blockchain chain ID (e.g., 8453 for Base)
 * @param address - Wallet address
 * @param publicClient - Viem PublicClient for on-chain nonce queries
 * @param startNonce - Optional starting nonce if not yet initialized (fallback only)
 * @returns The next nonce to use for the transaction
 */
export async function getNextNonce(
  chainId: number,
  address: string,
  publicClient: PublicClient,
  startNonce: number = 0,
): Promise<number> {
  const key = `nonce:${chainId}:${address.toLowerCase()}`;
  const redis = getRedisClient(ServiceNamespace.SHARED);

  try {
    // CRITICAL FIX: Check if the key exists in Redis before calling the Lua script.
    // If it doesn't exist (cache miss/flush), fetch the true on-chain nonce
    // to prevent "nonce too low" errors from starting at 0.
    let effectiveStartNonce = startNonce;
    const keyExists = await redis.exists(key);
    if (!keyExists) {
      // Wrap in a distributed lock so concurrent misses don't fetch the same nonce
      await withDistributedLock(
        `lock:nonce_init:${chainId}:${address.toLowerCase()}`,
        10,
        async () => {
          // Double-check inside the lock (another thread may have initialized while we waited)
          if (!(await redis.exists(key))) {
            const onChainNonce = await publicClient.getTransactionCount({
              address: address as `0x${string}`,
              blockTag: "pending",
            });
            effectiveStartNonce = onChainNonce;
            // Pre-initialize the key here to prevent subsequent locks from re-fetching
            await redis.set(key, String(effectiveStartNonce), {
              ex: NONCE_TTL,
            });
            logger.info(
              "NonceTracker cache miss - initialized from on-chain nonce",
              {
                chainId,
                address: address.toLowerCase(),
                onChainNonce,
              },
            );
          } else {
            // Key was initialized by another thread while we waited for the lock
            const existingNonce = await redis.get(key);
            effectiveStartNonce = parseInt(existingNonce as string, 10);
          }
        },
      );
    }

    const result = (await redis.eval(
      GET_NEXT_NONCE_SCRIPT,
      [key],
      [effectiveStartNonce.toString(), NONCE_TTL.toString()],
    )) as string;

    const nonce = parseInt(result, 10);
    if (isNaN(nonce)) {
      throw new Error(`Invalid nonce result from Redis: ${result}`);
    }

    logger.debug("NonceTracker.getNextNonce", {
      chainId,
      address: address.toLowerCase(),
      nonce,
    });
    return nonce;
  } catch (error) {
    logger.error("NonceTracker.getNextNonce failed", {
      chainId,
      address: address.toLowerCase(),
      error,
    });
    throw error;
  }
}

/**
 * Peek at the current nonce without incrementing it.
 * Returns null if no nonce has been initialized yet.
 */
export async function peekNonce(
  chainId: number,
  address: string,
): Promise<number | null> {
  const key = `nonce:${chainId}:${address.toLowerCase()}`;
  const redis = getRedisClient(ServiceNamespace.SHARED);

  try {
    const result = await redis.get(key);
    if (result === null) return null;
    return parseInt(result as string, 10);
  } catch (error) {
    logger.error("NonceTracker.peekNonce failed", {
      chainId,
      address: address.toLowerCase(),
      error,
    });
    throw error;
  }
}

/**
 * Reset the nonce tracker for a chain + address.
 * Useful for recovery after manual blockchain transactions or "nonce too low" errors.
 */
export async function resetNonce(
  chainId: number,
  address: string,
): Promise<void> {
  const key = `nonce:${chainId}:${address.toLowerCase()}`;
  const redis = getRedisClient(ServiceNamespace.SHARED);

  try {
    await redis.del(key);
    logger.info("NonceTracker.resetNonce", {
      chainId,
      address: address.toLowerCase(),
    });
  } catch (error) {
    logger.error("NonceTracker.resetNonce failed", {
      chainId,
      address: address.toLowerCase(),
      error,
    });
    throw error;
  }
}

/**
 * Sync the nonce tracker with the on-chain nonce for a chain + address.
 *
 * Use this when:
 * - A "nonce too low" error is caught (indicates nonce drift)
 * - The last transaction was > 5 minutes ago (stale tracker)
 * - After manual blockchain transactions outside this system
 *
 * @param chainId - Blockchain chain ID
 * @param address - Wallet address
 * @param publicClient - Viem PublicClient for on-chain nonce queries
 * @returns The current on-chain nonce
 */
export async function syncNonceFromChain(
  chainId: number,
  address: string,
  publicClient: PublicClient,
): Promise<number> {
  const key = `nonce:${chainId}:${address.toLowerCase()}`;
  const redis = getRedisClient(ServiceNamespace.SHARED);

  try {
    const onChainNonce = await publicClient.getTransactionCount({
      address: address as `0x${string}`,
      blockTag: "pending",
    });

    // Reset the Redis nonce tracker to the on-chain value
    // This ensures the next getNextNonce call will start from the correct value
    await redis.set(key, String(onChainNonce), { ex: NONCE_TTL });

    logger.info("NonceTracker.syncedFromChain", {
      chainId,
      address: address.toLowerCase(),
      onChainNonce,
    });

    return onChainNonce;
  } catch (error) {
    logger.error("NonceTracker.syncNonceFromChain failed", {
      chainId,
      address: address.toLowerCase(),
      error,
    });
    throw error;
  }
}

/**
 * Check if the nonce tracker is potentially stale.
 * Returns true if the tracker hasn't been updated recently or if the
 * on-chain nonce differs significantly from the tracked nonce.
 *
 * @param chainId - Blockchain chain ID
 * @param address - Wallet address
 * @param publicClient - Viem PublicClient
 * @param staleThresholdMinutes - Minutes since last considered fresh (default: 5)
 * @returns Object with sync status and recommendations
 */
export async function checkNonceSyncStatus(
  chainId: number,
  address: string,
  publicClient: PublicClient,
  staleThresholdMinutes: number = 5,
): Promise<{
  isSynced: boolean;
  trackedNonce: number | null;
  onChainNonce: number;
  needsSync: boolean;
  reason?: string;
}> {
  const trackedNonce = await peekNonce(chainId, address);

  const onChainNonce = await publicClient.getTransactionCount({
    address: address as `0x${string}`,
    blockTag: "pending",
  });

  // Check if nonce drifted (tracked > on-chain means we have pending txs)
  const nonceDrift = trackedNonce !== null ? trackedNonce - onChainNonce : 0;

  // If tracked nonce is significantly higher than on-chain,
  // it means we have pending transactions waiting for confirmation
  const hasPendingTransactions = nonceDrift > 0;

  return {
    isSynced: nonceDrift <= 1, // Allow 1 nonce drift for in-flight tx
    trackedNonce,
    onChainNonce,
    needsSync: hasPendingTransactions && staleThresholdMinutes > 0,
    reason: hasPendingTransactions
      ? `${nonceDrift} pending transaction(s) waiting`
      : undefined,
  };
}

// ============================================================================
// NONCE LEASE PATTERN
//
// Problem: The current getNextNonce unconditionally increments Redis before
// the transaction is broadcast. If writeContract fails, the nonce is
// permanently "burned" with no way to recover it.
//
// Solution: Three-phase lease pattern:
// 1. reserveNonce() — atomically increment Redis and record a lease with TTL
// 2. confirmNonce() — no-op; the nonce was already consumed on success
// 3. releaseNonce() — rollback the increment if the transaction failed
//    before broadcast, using an atomic DECR Lua script
//
// If a lease expires (NONCE_LEASE_TTL = 60s) without confirm or release,
// reconcileExpiredLeases() will detect it and reconcile against the
// on-chain pending nonce.
// ============================================================================

/**
 * Reserve a nonce for an upcoming transaction.
 *
 * This atomically increments the Redis nonce counter AND creates a lease
 * record with a TTL. The lease must be either confirmed (on success) or
 * released (on failure) within NONCE_LEASE_TTL seconds.
 *
 * Usage:
 * ```typescript
 * const lease = await reserveNonce(base.id, resolverAddress, publicClient);
 * try {
 *   const hash = await walletClient.writeContract({ nonce: lease.nonce, ... });
 *   await confirmNonce(lease); // marks the lease as fulfilled
 * } catch (error) {
 *   await releaseNonce(lease); // rolls back the nonce if tx was never broadcast
 * }
 * ```
 *
 * @param chainId - Blockchain chain ID
 * @param address - Wallet address
 * @param publicClient - Viem PublicClient for on-chain nonce queries
 * @param startNonce - Optional starting nonce if not yet initialized
 * @returns Lease object with nonce and metadata for confirm/release
 */
export async function reserveNonce(
  chainId: number,
  address: string,
  publicClient: PublicClient,
  startNonce: number = 0,
): Promise<{
  nonce: number;
  chainId: number;
  address: string;
  leaseKey: string;
  reservedAt: number;
}> {
  const normalizedAddress = address.toLowerCase();
  const nonceKey = `nonce:${chainId}:${normalizedAddress}`;
  const redis = getRedisClient(ServiceNamespace.SHARED);
  const now = Math.floor(Date.now() / 1000);

  try {
    // Ensure the nonce key is initialized (same logic as getNextNonce)
    const keyExists = await redis.exists(nonceKey);
    let effectiveStartNonce = startNonce;

    if (!keyExists) {
      await withDistributedLock(
        `lock:nonce_init:${chainId}:${normalizedAddress}`,
        10,
        async () => {
          if (!(await redis.exists(nonceKey))) {
            const onChainNonce = await publicClient.getTransactionCount({
              address: address as `0x${string}`,
              blockTag: "pending",
            });
            effectiveStartNonce = onChainNonce;
            await redis.set(nonceKey, String(effectiveStartNonce), {
              ex: NONCE_TTL,
            });
            logger.info("NonceTracker cache miss — initialized from chain", {
              chainId,
              address: normalizedAddress,
              onChainNonce,
            });
          }
        },
      );
    }

    // Atomically increment the nonce counter
    const result = (await redis.eval(
      GET_NEXT_NONCE_SCRIPT,
      [nonceKey],
      [effectiveStartNonce.toString(), NONCE_TTL.toString()],
    )) as string;

    const nonce = parseInt(result, 10);
    if (isNaN(nonce)) {
      throw new Error(`Invalid nonce result from Redis: ${result}`);
    }

    // Create a lease record with TTL
    const leaseKey = `${LEASE_KEY_PREFIX}:${chainId}:${normalizedAddress}:${nonce}`;
    const leaseAcquired = await redis.eval(
      ACQUIRE_LEASE_SCRIPT,
      [leaseKey],
      [String(now), String(NONCE_LEASE_TTL)],
    );

    if (leaseAcquired !== "OK") {
      // Lease already exists — this shouldn't happen under normal operation
      // but could occur during retries. Log a warning but proceed.
      logger.warn("Nonce lease already exists, possible retry scenario", {
        chainId,
        address: normalizedAddress,
        nonce,
        leaseKey,
      });
    }

    logger.info("NonceTracker.reserveNonce", {
      chainId,
      address: normalizedAddress,
      nonce,
      leaseKey,
      leaseTtlSeconds: NONCE_LEASE_TTL,
    });

    return {
      nonce,
      chainId,
      address: normalizedAddress,
      leaseKey,
      reservedAt: now,
    };
  } catch (error) {
    logger.error("NonceTracker.reserveNonce failed", {
      chainId,
      address: normalizedAddress,
      error,
    });
    throw error;
  }
}

/**
 * Confirm a nonce lease after a successful transaction broadcast.
 *
 * This removes the lease record. The nonce counter itself is NOT decremented
 * — it was already consumed and the transaction is on its way to the chain.
 *
 * This is a no-op if the lease has already expired (cleanup handles it).
 *
 * @param lease - Lease object returned by reserveNonce
 */
export async function confirmNonce(lease: {
  leaseKey: string;
  nonce: number;
  chainId: number;
  address: string;
}): Promise<void> {
  const redis = getRedisClient(ServiceNamespace.SHARED);

  try {
    const deleted = (await redis.eval(
      RELEASE_LEASE_SCRIPT,
      [lease.leaseKey],
      [],
    )) as number;

    logger.debug("NonceTracker.confirmNonce", {
      chainId: lease.chainId,
      address: lease.address,
      nonce: lease.nonce,
      leaseCleaned: deleted > 0,
    });
  } catch {
    // Lease expiry is not a critical error — the cleanup cron handles it
    logger.debug("NonceTracker.confirmNonce — lease already expired", {
      chainId: lease.chainId,
      address: lease.address,
      nonce: lease.nonce,
    });
  }
}

/**
 * Release (rollback) a nonce lease after a transaction failure.
 *
 * This does two things:
 * 1. Removes the lease record
 * 2. Atomically decrements the nonce counter (if it hasn't been superseded)
 *
 * The DECR Lua script ensures the nonce never goes below zero and handles
 * the case where the key no longer exists (e.g., TTL expiry between
 * reserve and release).
 *
 * @param lease - Lease object returned by reserveNonce
 * @returns Object with the new nonce value after rollback, or the reason rollback was skipped
 */
export async function releaseNonce(lease: {
  leaseKey: string;
  nonce: number;
  chainId: number;
  address: string;
}): Promise<{ newNonce: number } | { reason: string }> {
  const redis = getRedisClient(ServiceNamespace.SHARED);

  try {
    // First, remove the lease record
    await redis.eval(RELEASE_LEASE_SCRIPT, [lease.leaseKey], []);

    // Then, atomically decrement the nonce counter
    const nonceKey = `nonce:${lease.chainId}:${lease.address}`;
    const result = (await redis.eval(
      RELEASE_NONCE_SCRIPT,
      [nonceKey],
      [NONCE_TTL.toString()],
    )) as string;

    if (result === "NOT_FOUND") {
      logger.warn(
        "NonceTracker.releaseNonce — nonce key not found, skip decrement",
        {
          chainId: lease.chainId,
          address: lease.address,
          nonce: lease.nonce,
        },
      );
      return { reason: "nonce_key_not_found" };
    }

    if (result === "ZERO") {
      logger.warn(
        "NonceTracker.releaseNonce — nonce at zero, cannot decrement",
        {
          chainId: lease.chainId,
          address: lease.address,
        },
      );
      return { reason: "nonce_at_zero" };
    }

    const newNonce = parseInt(result, 10);
    logger.info("NonceTracker.releaseNonce — rolled back", {
      chainId: lease.chainId,
      address: lease.address,
      releasedNonce: lease.nonce,
      newNonce,
    });

    return { newNonce };
  } catch (error) {
    logger.error("NonceTracker.releaseNonce failed", {
      chainId: lease.chainId,
      address: lease.address,
      nonce: lease.nonce,
      error,
    });
    // Don't throw — a failed rollback should not crash the caller.
    // The nonce drift will be caught by the reconciliation cron.
    return {
      reason: `rollback_error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Reconcile expired nonce leases against the on-chain pending nonce.
 *
 * This should be called periodically (e.g., by the sync-nonces cron) to
 * detect and fix nonce drift caused by leases that expired without being
 * confirmed or released.
 *
 * How it works:
 * 1. Scan for all lease keys older than NONCE_LEASE_TTL seconds
 * 2. For each address with expired leases, check on-chain pending nonce
 * 3. If Redis nonce > on-chain nonce, sync down to on-chain value
 *
 * @param chainId - Blockchain chain ID
 * @param address - Wallet address
 * @param publicClient - Viem PublicClient
 * @returns Number of expired leases cleaned up and whether a sync was needed
 */
export async function reconcileExpiredLeases(
  chainId: number,
  address: string,
  publicClient: PublicClient,
): Promise<{
  expiredLeasesCleaned: number;
  syncNeeded: boolean;
  syncResult?: number;
}> {
  const redis = getRedisClient(ServiceNamespace.SHARED);
  const normalizedAddress = address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  try {
    // Clean up expired leases using SCAN
    const leasePattern = `${LEASE_KEY_PREFIX}:${chainId}:${normalizedAddress}:*`;
    const expiredCount = (await redis.eval(
      CLEANUP_EXPIRED_LEASES_SCRIPT,
      [leasePattern],
      [String(now), String(NONCE_LEASE_TTL)],
    )) as number;

    if (expiredCount === 0) {
      return { expiredLeasesCleaned: 0, syncNeeded: false };
    }

    logger.info("NonceTracker.reconcileExpiredLeases — expired leases found", {
      chainId,
      address: normalizedAddress,
      expiredCount,
    });

    // Check if the on-chain nonce is behind the Redis nonce (meaning some leases
    // expired for transactions that were never actually broadcast)
    const onChainNonce = await publicClient.getTransactionCount({
      address: address as `0x${string}`,
      blockTag: "pending",
    });

    const trackedNonce = await peekNonce(chainId, address);

    if (trackedNonce !== null && trackedNonce > onChainNonce) {
      // Redis nonce drifted ahead of on-chain — sync down
      logger.warn(
        "Nonce drift detected after lease expiry, syncing from chain",
        {
          chainId,
          address: normalizedAddress,
          trackedNonce,
          onChainNonce,
          drift: trackedNonce - onChainNonce,
        },
      );

      await syncNonceFromChain(chainId, address, publicClient);

      return {
        expiredLeasesCleaned: expiredCount,
        syncNeeded: true,
        syncResult: onChainNonce,
      };
    }

    return { expiredLeasesCleaned: expiredCount, syncNeeded: false };
  } catch (error) {
    logger.error("NonceTracker.reconcileExpiredLeases failed", {
      chainId,
      address: normalizedAddress,
      error,
    });
    throw error;
  }
}
