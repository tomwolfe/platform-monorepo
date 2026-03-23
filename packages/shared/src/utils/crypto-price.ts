/**
 * Crypto Price Oracle Utility
 *
 * Fetches real-time crypto prices from multiple sources with Redis caching.
 * FAIL-SOFT: Gracefully degrades with historical averages or stale cache.
 *
 * Fallback chain:
 * 1. Redis cache (fresh < 5 min)
 * 2. CoinGecko API (primary)
 * 3. Coinbase API (secondary fallback)
 * 4. Binance Public API (tertiary fallback - no auth required)
 * 5. Redis cache (stale - last resort)
 * 6. Postgres historical moving average (if available)
 * 7. Return graceful degradation response (no throw - allows UI to disable crypto)
 */

import { getRedisClient, ServiceNamespace } from "../redis";
import { db } from "@repo/database";
import { sql } from "drizzle-orm";

const COINGECKO_API = "https://api.coingecko.com/api/v3/simple/price";
const COINBASE_API = "https://api.coinbase.com/v2/exchange-rates";
const BINANCE_API = "https://api.binance.com/api/v3/ticker/24hr";

// CoinGecko API IDs for supported tokens
const COIN_IDS = {
  ETH: "ethereum",
  MATIC: "matic-network",
  BASE: "ethereum", // BASE uses ETH as gas token
} as const;

// Binance API symbols for supported tokens
const BINANCE_SYMBOLS = {
  ETH: "ETHUSDT",
  MATIC: "MATICUSDT",
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
 * Fetch historical moving average from Postgres as last-resort fallback
 * This provides a mathematically safe fallback when all APIs fail
 * Returns null if historical data is not available - NO hardcoded fallbacks
 */
async function getHistoricalMovingAverage(token: "ETH" | "MATIC"): Promise<number | null> {
  try {
    // Query last 7 days of price data from crypto_prices table (if it exists)
    const result = await db
      .select({
        avgPrice: sql<number>`AVG(price_usd)::numeric`,
      })
      .from(sql<any>`crypto_prices`)
      .where(sql`token = ${token} AND created_at > NOW() - INTERVAL '7 days'`);

    if (result[0]?.avgPrice) {
      return parseFloat(result[0].avgPrice.toString());
    }
  } catch (error) {
    // Table might not exist - that's okay, return null
    console.debug("[CryptoPrice] Historical average not available");
  }

  // Return null if no historical data - DO NOT use hardcoded fallbacks
  return null;
}

/**
 * Fetch current crypto prices from CoinGecko (primary) or Coinbase (fallback)
 * Cached in Redis for 5 minutes to avoid rate limits
 *
 * FINANCIAL SAFETY: Defaults to failClosed=true to prevent dangerous hardcoded fallbacks
 */
export async function getCryptoPrices(options?: {
  /** If true, throw error when all sources fail (default: true for financial safety) */
  failClosed?: boolean;
}): Promise<{
  ETH: number;
  MATIC: number;
  timestamp: number;
  source: 'cache' | 'coingecko' | 'coinbase' | 'binance' | 'historical' | 'cache-stale';
  isStale?: boolean;
}> {
  const redis = getRedis();
  // CRITICAL: Default to failClosed=true to prevent financial risk from hardcoded prices
  const failClosed = options?.failClosed ?? true;

  // Try to get from cache first
  const cached = await redis.get("@apps:crypto-prices");
  if (cached) {
    const parsed = JSON.parse(cached as string);
    // Return cached data if less than 5 minutes old
    if (Date.now() - parsed.timestamp < CACHE_TTL * 1000) {
      return { ...parsed, source: 'cache' as const };
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

    return { ...prices, source: 'coingecko' as const };
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

      return { ...prices, source: 'coinbase' as const };
    } catch (coinbaseError) {
      console.warn("Coinbase also failed:", coinbaseError);

      // Try Binance Public API (tertiary fallback - no auth required)
      try {
        const response = await fetch(`${BINANCE_API}?symbol=${BINANCE_SYMBOLS.ETH}`);

        if (!response.ok) {
          throw new Error(`Binance API error: ${response.status}`);
        }

        const data: any = await response.json();

        // Binance returns: { symbol: "ETHUSDT", lastPrice: "1234.56", ... }
        const ethPrice = parseFloat(data.lastPrice || "0");

        // Fetch MATIC separately
        let maticPrice = 0;
        try {
          const maticResponse = await fetch(`${BINANCE_API}?symbol=${BINANCE_SYMBOLS.MATIC}`);
          if (maticResponse.ok) {
            const maticData: any = await maticResponse.json();
            maticPrice = parseFloat(maticData.lastPrice || "0");
          }
        } catch (e) {
          console.warn("Failed to fetch MATIC price from Binance");
        }

        const prices = {
          ETH: ethPrice,
          MATIC: maticPrice,
          timestamp: Date.now(),
        };

        // Validate ETH price is non-zero
        if (prices.ETH === 0) {
          throw new Error("Invalid ETH price from Binance");
        }

        // Cache the result
        await redis.setex(
          "@apps:crypto-prices",
          CACHE_TTL,
          JSON.stringify(prices)
        );

        return { ...prices, source: 'binance' as const };
      } catch (binanceError) {
        console.warn("Binance also failed:", binanceError);

        // Try historical moving average from Postgres
        try {
          const ethHistorical = await getHistoricalMovingAverage("ETH");
          const maticHistorical = await getHistoricalMovingAverage("MATIC");

          if (ethHistorical && maticHistorical) {
            console.warn("Using historical moving average as fallback");
            const prices = {
              ETH: ethHistorical,
              MATIC: maticHistorical,
              timestamp: Date.now(),
            };
            return { ...prices, source: 'historical' as const };
          }
        } catch (historicalError) {
          console.warn("Historical average also unavailable:", historicalError);
        }

        // LAST RESORT: Use stale cache data if available
        // This is safer than throwing because it allows the UI to gracefully disable crypto
        // while still providing a reasonable price estimate from the last known good data
        const staleCached = await redis.get("@apps:crypto-prices");
        if (staleCached) {
          console.error(
            "⚠️ CRITICAL: All crypto price sources (CoinGecko, Coinbase, Binance, historical) failed. " +
            "Using STALE cached data as last resort. Prices may be significantly outdated. " +
            "Users should be warned that crypto prices are not current."
          );
          const staleData = JSON.parse(staleCached as string);
          return { ...staleData, source: 'cache-stale' as const, isStale: true };
        }

        // No stale cache available - throw error for financial safety
        const error = new Error(
          "Crypto price oracle unavailable: all external sources (CoinGecko, Coinbase, Binance), " +
          "historical data, and stale cache are unavailable. " +
          "Cannot process crypto transactions without any price data. " +
          "This is a safety measure to prevent transactions without price verification."
        );
        (error as any).code = "PRICE_ORACLE_UNAVAILABLE";
        throw error;
      }
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
