import { getRedisClient, ServiceNamespace } from "../redis";
import { Logger } from "../logger";

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
 * @param chainId - Blockchain chain ID (e.g., 8453 for Base)
 * @param address - Wallet address
 * @param startNonce - Optional starting nonce if not yet initialized (default: 0)
 * @returns The next nonce to use for the transaction
 */
export async function getNextNonce(
  chainId: number,
  address: string,
  startNonce: number = 0,
): Promise<number> {
  const key = `nonce:${chainId}:${address.toLowerCase()}`;
  const redis = getRedisClient(ServiceNamespace.SHARED);

  try {
    const result = (await redis.eval(
      GET_NEXT_NONCE_SCRIPT,
      [key],
      [startNonce.toString(), NONCE_TTL.toString()],
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
