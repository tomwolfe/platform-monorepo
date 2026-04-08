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
 *
 * CI/TEST MOCKING: Returns static prices when CI=true or NODE_ENV=test
 */

import { getRedisClient, ServiceNamespace } from "../redis";
import { getDb, cryptoPrices, eq, lt, gt, and } from "@repo/database";
import { sql } from "drizzle-orm";
import { parseUnits, formatUnits } from "viem";

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

// Cache TTL in seconds (30 seconds for fresh data)
const CACHE_TTL = 30;

// Stale-while-revalidate threshold (5 minutes max age for stale data)
const STALE_CACHE_TTL = 300;

interface CoinbaseExchangeRates {
  data?: {
    rates?: {
      USD?: string;
    };
  };
}

interface BinanceTickerData {
  symbol: string;
  lastPrice: string;
  [key: string]: unknown;
}

interface CachedPriceData {
  ETH: number;
  MATIC: number;
  timestamp: number;
}

// CI/TEST MODE: Static mock prices for deterministic testing
const CI_MOCK_PRICES = {
  ETH: 3000,
  MATIC: 0.5,
  timestamp: Date.now(),
  source: "mock" as const,
};

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
async function getHistoricalMovingAverage(
  token: "ETH" | "MATIC",
): Promise<number | null> {
  try {
    // Query last 7 days of price data from crypto_prices table
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const result = await getDb()
      .select({
        avgPrice: sql<number>`AVG(${cryptoPrices.priceUsd})::numeric`,
      })
      .from(cryptoPrices)
      .where(
        and(
          eq(cryptoPrices.token, token),
          gt(cryptoPrices.createdAt, sevenDaysAgo),
        ),
      );

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
 *
 * CI/TEST MODE: Returns static mock prices when CI=true or NODE_ENV=test
 */
export async function getCryptoPrices(options?: {
  /** If true, throw error when all sources fail (default: true for financial safety) */
  failClosed?: boolean;
}): Promise<{
  ETH: number;
  MATIC: number;
  timestamp: number;
  source:
    | "cache"
    | "coingecko"
    | "coinbase"
    | "binance"
    | "historical"
    | "cache-stale"
    | "mock";
  isStale?: boolean;
}> {
  // CI/TEST MODE: Return static mock prices for deterministic, offline-safe testing
  if (process.env.CI === "true" || process.env.NODE_ENV === "test") {
    console.log("[CryptoPrice] CI/Test mode detected - returning mock prices");
    return {
      ...CI_MOCK_PRICES,
      timestamp: Date.now(),
    };
  }

  const redis = getRedis();
  // CRITICAL: Default to failClosed=true to prevent financial risk from hardcoded prices
  const failClosed = options?.failClosed ?? true;

  // Try to get from cache first (wrapped in try-catch to prevent SPOF)
  let cached: CachedPriceData | null = null;
  let isStale = false;
  try {
    const cachedRaw = await redis.get("@apps:crypto-prices");
    if (cachedRaw) {
      cached = JSON.parse(cachedRaw as string) as CachedPriceData;
      const cacheAge = Date.now() - (cached?.timestamp ?? 0);

      // Return cached data if less than 30 seconds old (fresh cache)
      if (cached && cacheAge < CACHE_TTL * 1000) {
        return { ...cached, source: "cache" as const, isStale: false };
      }

      // Mark as stale if between 30 seconds and 5 minutes old
      if (cached && cacheAge < STALE_CACHE_TTL * 1000) {
        isStale = true;
        console.warn(
          `[CryptoPrice] Using stale cache data (${Math.round(cacheAge / 1000)}s old). ` +
            `Attempting to refresh in background.`,
        );
      }
    }
  } catch (error) {
    // Redis failure - log warning and proceed to API fallbacks
    console.warn(
      "[CryptoPrice] Redis cache read failed, proceeding to API fallbacks:",
      error,
    );
  }

  // Try CoinGecko (primary)
  try {
    const url = `${COINGECKO_API}?ids=${COIN_IDS.ETH},${COIN_IDS.MATIC}&vs_currencies=usd&include_24hr_change=true`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

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
    await redis.setex("@apps:crypto-prices", CACHE_TTL, JSON.stringify(prices));

    return { ...prices, source: "coingecko" as const, isStale: false };
  } catch (coingeckoError) {
    console.warn("CoinGecko failed, trying Coinbase:", coingeckoError);

    // Try Coinbase (secondary fallback)
    try {
      const coinbaseController = new AbortController();
      const coinbaseTimeoutId = setTimeout(
        () => coinbaseController.abort(),
        3000,
      );

      const response = await fetch(`${COINBASE_API}?currency=ETH`, {
        headers: {
          Accept: "application/json",
        },
        signal: coinbaseController.signal,
      });

      clearTimeout(coinbaseTimeoutId);

      if (!response.ok) {
        throw new Error(`Coinbase API error: ${response.status}`);
      }

      const data: CoinbaseExchangeRates = await response.json();

      // Coinbase returns rates in data.data.rates
      const ethPrice = parseFloat(data.data?.rates?.USD || "0");

      // For MATIC, try to fetch separately or use a reasonable estimate from ETH ratio
      let maticPrice = 0;
      try {
        const maticController = new AbortController();
        const maticTimeoutId = setTimeout(() => maticController.abort(), 3000);

        const maticResponse = await fetch(`${COINBASE_API}?currency=MATIC`, {
          headers: {
            Accept: "application/json",
          },
          signal: maticController.signal,
        });

        clearTimeout(maticTimeoutId);

        if (maticResponse.ok) {
          const maticData: CoinbaseExchangeRates = await maticResponse.json();
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
        JSON.stringify(prices),
      );

      return { ...prices, source: "coinbase" as const, isStale: false };
    } catch (coinbaseError) {
      console.warn("Coinbase also failed:", coinbaseError);

      // Try Binance Public API (tertiary fallback - no auth required)
      try {
        const binanceController = new AbortController();
        const binanceTimeoutId = setTimeout(
          () => binanceController.abort(),
          3000,
        );

        const response = await fetch(
          `${BINANCE_API}?symbol=${BINANCE_SYMBOLS.ETH}`,
          {
            signal: binanceController.signal,
          },
        );

        clearTimeout(binanceTimeoutId);

        if (!response.ok) {
          throw new Error(`Binance API error: ${response.status}`);
        }

        const data: BinanceTickerData = await response.json();

        // Binance returns: { symbol: "ETHUSDT", lastPrice: "1234.56", ... }
        const ethPrice = parseFloat(data.lastPrice || "0");

        // Fetch MATIC separately
        let maticPrice = 0;
        try {
          const binanceMaticController = new AbortController();
          const binanceMaticTimeoutId = setTimeout(
            () => binanceMaticController.abort(),
            3000,
          );

          const maticResponse = await fetch(
            `${BINANCE_API}?symbol=${BINANCE_SYMBOLS.MATIC}`,
            {
              signal: binanceMaticController.signal,
            },
          );

          clearTimeout(binanceMaticTimeoutId);

          if (maticResponse.ok) {
            const maticData: BinanceTickerData = await maticResponse.json();
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
          JSON.stringify(prices),
        );

        return { ...prices, source: "binance" as const, isStale: false };
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
            return { ...prices, source: "historical" as const, isStale: true };
          }
        } catch (historicalError) {
          console.warn("Historical average also unavailable:", historicalError);
        }

        // LAST RESORT: Use stale cache data if available
        // This is safer than throwing because it allows the UI to gracefully disable crypto
        // while still providing a reasonable price estimate from the last known good data
        let staleCached: CachedPriceData | null = null;
        try {
          const staleCachedRaw = await redis.get("@apps:crypto-prices");
          if (staleCachedRaw) {
            staleCached = JSON.parse(
              staleCachedRaw as string,
            ) as CachedPriceData;
          }
        } catch (error) {
          console.warn(
            "[CryptoPrice] Redis stale cache read also failed:",
            error,
          );
        }

        if (staleCached) {
          console.error(
            "⚠️ CRITICAL: All crypto price sources (CoinGecko, Coinbase, Binance, historical) failed. " +
              "Using STALE cached data as last resort. Prices may be significantly outdated. " +
              "Users should be warned that crypto prices are not current.",
          );
          return {
            ...staleCached,
            source: "cache-stale" as const,
            isStale: true,
          };
        }

        // No stale cache available - throw error for financial safety
        const error = new Error(
          "Crypto price oracle unavailable: all external sources (CoinGecko, Coinbase, Binance), " +
            "historical data, and stale cache are unavailable. " +
            "Cannot process crypto transactions without any price data. " +
            "This is a safety measure to prevent transactions without price verification.",
        );
        (error as any).code = "PRICE_ORACLE_UNAVAILABLE";
        (error as any).details = {
          coingeckoError:
            coingeckoError instanceof Error
              ? coingeckoError.message
              : String(coingeckoError),
          binanceError:
            binanceError instanceof Error
              ? binanceError.message
              : String(binanceError),
        };
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
 * Convert USD amount to crypto token amount using bigint arithmetic.
 *
 * @param usdAmount - USD amount (in cents to avoid floating point, e.g. $1.50 = 150)
 * @param token - Token symbol
 * @param decimals - Token decimals (ETH=18, MATIC=18)
 * @returns Crypto amount in token's smallest unit (wei)
 */
export async function usdToCryptoBigInt(
  usdAmountCents: bigint,
  token: "ETH" | "MATIC",
  decimals: number = 18,
): Promise<bigint> {
  const price = await getTokenPrice(token);
  if (price === 0) {
    throw new Error("Invalid price data");
  }

  // price is in USD per token (e.g., ETH = 3000.0)
  // usdAmountCents is in cents (e.g., $1.50 = 150 cents)
  // Convert price to cents: price * 100
  // cryptoAmount = usdAmountCents / (price * 100) in tokens
  // Then convert to wei: cryptoAmount * 10^decimals

  // CRITICAL FIX: Use parseUnits to avoid floating-point precision loss
  // Convert price to a 6-decimal string, then parse to BigInt safely
  const priceScaled = parseUnits(price.toFixed(6), 6);

  // Calculate: (usdAmountCents * 10^18) / (priceInCents)
  // where priceInCents = priceScaled (already has 6 decimals)
  // We need to normalize: usdAmountCents has 2 decimals (cents)
  // Result should have 'decimals' places (e.g., 18 for ETH)

  // Formula: cryptoAmountWei = (usdAmountCents * 10^decimals * 10^6) / (priceScaled * 10^2)
  // Simplified: (usdAmountCents * 10^(decimals + 4)) / priceScaled
  // CRITICAL: Use BigInt literals (10n ** BigInt(...)) to avoid Float64 precision loss
  // for exponents that exceed Number.MAX_SAFE_INTEGER (e.g., 10^22)
  const numerator = usdAmountCents * 10n ** BigInt(decimals + 4);
  const denominator = priceScaled;

  if (denominator === 0n) {
    throw new Error("Price scaled to zero");
  }

  const cryptoAmountTokens = numerator / denominator;
  return cryptoAmountTokens;
}

/**
 * Convert crypto token amount to USD using bigint arithmetic.
 *
 * @param cryptoAmountWei - Crypto amount in token's smallest unit (wei)
 * @param token - Token symbol
 * @returns USD amount in cents
 */
export async function cryptoToUsdBigInt(
  cryptoAmountWei: bigint,
  token: "ETH" | "MATIC",
): Promise<bigint> {
  const price = await getTokenPrice(token);
  if (price === 0) {
    return 0n;
  }

  // price is in USD per token (e.g., ETH = 3000.0)
  // cryptoAmountWei is in wei (10^-18 tokens)
  // usdAmount = (cryptoAmountWei / 10^18) * price
  // Return in cents: usdAmount * 100

  const priceScaled = BigInt(Math.round(price * 100)); // Price in cents
  // CRITICAL: Use 10n ** 18n to avoid Float64 precision loss
  const usdCents = (cryptoAmountWei * priceScaled) / 10n ** 18n;
  return usdCents;
}

/**
 * Calculate expected crypto amount with slippage buffer using bigint arithmetic.
 * Safe for crypto transaction calculations.
 *
 * @param usdAmountCents - USD amount in cents
 * @param token - Token symbol
 * @param slippageBps - Slippage tolerance in basis points (100 = 1%, 200 = 2%)
 * @param decimals - Token decimals (default 18)
 * @returns Crypto amount in token's smallest unit (wei) with slippage buffer
 */
export async function usdToCryptoBigIntWithSlippage(
  usdAmountCents: bigint,
  token: "ETH" | "MATIC",
  slippageBps: number = 100,
  decimals: number = 18,
): Promise<bigint> {
  const cryptoAmount = await usdToCryptoBigInt(usdAmountCents, token, decimals);
  const BASIS_POINTS = 10_000n;
  // Add slippage buffer
  return (cryptoAmount * (BASIS_POINTS + BigInt(slippageBps))) / BASIS_POINTS;
}

/**
 * Check if an actual crypto value is within slippage tolerance of the expected value.
 *
 * This is used for defense-in-depth verification after on-chain validation.
 * It allows a tolerance band to handle price volatility between signing and verification.
 *
 * @param actualValue - The actual value received (in smallest units, e.g. Wei)
 * @param expectedValue - The expected value (in smallest units)
 * @param slippageBps - Slippage tolerance in basis points (100 = 1%, 200 = 2%)
 * @returns True if actualValue is within the acceptable slippage band
 */
export function isWithinSlippage(
  actualValue: bigint,
  expectedValue: bigint,
  slippageBps: number,
): boolean {
  const BASIS_POINTS = 10_000n;
  const slippage = BigInt(slippageBps);
  const lowerBound = (expectedValue * (BASIS_POINTS - slippage)) / BASIS_POINTS;
  const upperBound = (expectedValue * (BASIS_POINTS + slippage)) / BASIS_POINTS;
  return actualValue >= lowerBound && actualValue <= upperBound;
}
