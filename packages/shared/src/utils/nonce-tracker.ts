import { getRedisClient, ServiceNamespace } from "../redis";
import { Logger } from "../logger";
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
      const onChainNonce = await publicClient.getTransactionCount({
        address: address as `0x${string}`,
        blockTag: "pending",
      });
      effectiveStartNonce = onChainNonce;
      logger.info("NonceTracker cache miss - initialized from on-chain nonce", {
        chainId,
        address: address.toLowerCase(),
        onChainNonce,
      });
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
