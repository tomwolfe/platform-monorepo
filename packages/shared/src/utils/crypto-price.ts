/**
 * Crypto Price Oracle Utility
 *
 * Fetches real-time crypto prices from CoinGecko API with Redis caching.
 * FAIL-CLOSED: Never uses hardcoded prices - throws error if all APIs fail.
 *
 * Fallback chain:
 * 1. Redis cache (fresh < 5 min)
 * 2. CoinGecko API (primary)
 * 3. Coinbase API (secondary fallback)
 * 4. Redis cache (stale - last resort)
 * 5. THROW ERROR (fail-closed - no hardcoded prices)
 */

import { getRedisClient, ServiceNamespace } from "../redis";

const COINGECKO_API = "https://api.coingecko.com/api/v3/simple/price";
const COINBASE_API = "https://api.coinbase.com/v2/exchange-rates";

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
 * Fetch current crypto prices from CoinGecko (primary) or Coinbase (fallback)
 * Cached in Redis for 5 minutes to avoid rate limits
 *
 * FAIL-CLOSED: Throws error if all APIs fail and no cache available
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

  // Try CoinGecko (primary)
  try {
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

    // Validate prices are non-zero
    if (prices.ETH === 0 || prices.MATIC === 0) {
      throw new Error("Invalid price data from CoinGecko");
    }

    // Cache the result
    await redis.setex(
      "@apps:crypto-prices",
      CACHE_TTL,
      JSON.stringify(prices)
    );

    return prices;
  } catch (coingeckoError) {
    console.warn("CoinGecko failed, trying Coinbase:", coingeckoError);

    // Try Coinbase (secondary fallback)
    try {
      const response = await fetch(`${COINBASE_API}?currency=ETH`, {
        headers: {
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        throw new Error(`Coinbase API error: ${response.status}`);
      }

      const data: any = await response.json();

      // Coinbase returns rates in data.data.rates
      const ethPrice = parseFloat(data.data?.rates?.USD || "0");
      
      // For MATIC, try to fetch separately or use a reasonable estimate from ETH ratio
      let maticPrice = 0;
      try {
        const maticResponse = await fetch(`${COINBASE_API}?currency=MATIC`, {
          headers: {
            Accept: "application/json",
          },
        });
        if (maticResponse.ok) {
          const maticData: any = await maticResponse.json();
          maticPrice = parseFloat(maticData.data?.rates?.USD || "0");
        }
      } catch (e) {
        console.warn("Failed to fetch MATIC price from Coinbase");
      }

      const prices = {
        ETH: ethPrice,
        MATIC: maticPrice,
        timestamp: Date.now(),
      };

      // Validate ETH price is non-zero (MATIC can be 0 if fetch failed)
      if (prices.ETH === 0) {
        throw new Error("Invalid ETH price from Coinbase");
      }

      // Cache the result
      await redis.setex(
        "@apps:crypto-prices",
        CACHE_TTL,
        JSON.stringify(prices)
      );

      return prices;
    } catch (coinbaseError) {
      console.warn("Coinbase also failed:", coinbaseError);

      // Last resort: try stale cache
      const staleCached = await redis.get("@apps:crypto-prices");
      if (staleCached) {
        console.warn("Using stale crypto price data as last resort");
        return JSON.parse(staleCached as string);
      }

      // FAIL-CLOSED: Throw error instead of using hardcoded prices
      const error = new Error(
        "Crypto price oracle unavailable: CoinGecko and Coinbase APIs failed, no cache available"
      );
      (error as any).code = "PRICE_ORACLE_UNAVAILABLE";
      throw error;
    }
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
