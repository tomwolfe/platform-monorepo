/**
 * Crypto Price Oracle Utility
 * 
 * Fetches real-time crypto prices from CoinGecko API
 * with Redis caching to avoid rate limits.
 */

import { getRedisClient, ServiceNamespace } from "../redis";

const COINGECKO_API = "https://api.coingecko.com/api/v3/simple/price";

// CoinGecko API IDs for supported tokens
const COIN_IDS = {
  ETH: "ethereum",
  MATIC: "matic-network",
  BASE: "ethereum", // BASE uses ETH as gas token
} as const;

// Cache TTL in seconds (5 minutes)
const CACHE_TTL = 300;

// Lazy redis client (initialized on first use)
let _redisClient: ReturnType<typeof getRedisClient> | null = null;

function getRedis(): ReturnType<typeof getRedisClient> {
  if (!_redisClient) {
    _redisClient = getRedisClient(ServiceNamespace.SHARED);
  }
  return _redisClient;
}

interface PriceData {
  usd: number;
  usd_24h_change?: number;
}

interface PriceResponse {
  ethereum?: PriceData;
  "matic-network"?: PriceData;
}

/**
 * Fetch current crypto prices from CoinGecko
 * Cached in Redis for 5 minutes to avoid rate limits
 */
export async function getCryptoPrices(): Promise<{
  ETH: number;
  MATIC: number;
  timestamp: number;
}> {
  const redis = getRedis();
  
  // Try to get from cache first
  const cached = await redis.get("@apps:crypto-prices");
  if (cached) {
    const parsed = JSON.parse(cached as string);
    // Return cached data if less than 5 minutes old
    if (Date.now() - parsed.timestamp < CACHE_TTL * 1000) {
      return parsed;
    }
  }

  try {
    // Fetch from CoinGecko
    const url = `${COINGECKO_API}?ids=${COIN_IDS.ETH},${COIN_IDS.MATIC}&vs_currencies=usd&include_24hr_change=true`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`CoinGecko API error: ${response.status}`);
    }

    const data: PriceResponse = await response.json();

    const prices = {
      ETH: data.ethereum?.usd ?? 0,
      MATIC: data["matic-network"]?.usd ?? 0,
      timestamp: Date.now(),
    };

    // Cache the result
    await redis.setex(
      "@apps:crypto-prices",
      CACHE_TTL,
      JSON.stringify(prices)
    );

    return prices;
  } catch (error) {
    console.error("Failed to fetch crypto prices:", error);
    
    // Fallback to cached data if available (even if stale)
    const staleCached = await redis.get("@apps:crypto-prices");
    if (staleCached) {
      console.warn("Using stale crypto price data");
      return JSON.parse(staleCached as string);
    }

    // Last resort fallback to hardcoded prices
    console.warn("Using fallback crypto prices");
    return {
      ETH: 2500,
      MATIC: 0.85,
      timestamp: Date.now(),
    };
  }
}

/**
 * Get price for a specific token
 */
export async function getTokenPrice(token: "ETH" | "MATIC"): Promise<number> {
  const prices = await getCryptoPrices();
  return prices[token];
}

/**
 * Convert USD amount to crypto token amount
 */
export async function usdToCrypto(
  usdAmount: number,
  token: "ETH" | "MATIC"
): Promise<number> {
  const price = await getTokenPrice(token);
  if (price === 0) {
    throw new Error("Invalid price data");
  }
  return usdAmount / price;
}

/**
 * Convert crypto token amount to USD
 */
export async function cryptoToUsd(
  cryptoAmount: number,
  token: "ETH" | "MATIC"
): Promise<number> {
  const price = await getTokenPrice(token);
  return cryptoAmount * price;
}

/**
 * Calculate expected crypto amount with slippage buffer
 * Adds a buffer to account for price movement during transaction confirmation
 */
export async function usdToCryptoWithSlippage(
  usdAmount: number,
  token: "ETH" | "MATIC",
  slippageBps: number = 100 // 1% = 100 basis points
): Promise<number> {
  const cryptoAmount = await usdToCrypto(usdAmount, token);
  // Add slippage buffer (increase amount to ensure payment is sufficient)
  return cryptoAmount * (1 + slippageBps / 10000);
}
