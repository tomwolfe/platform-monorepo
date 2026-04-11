import { getRedisClient, ServiceNamespace } from "../redis";
import { Logger } from "../logger";
import { withDistributedLock } from "../services/distributed-lock";
import type { PublicClient } from "viem";

const logger = new Logger({ serviceName: "nonce-tracker" });

const NONCE_TTL = 86400; // 24 hours in seconds

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
