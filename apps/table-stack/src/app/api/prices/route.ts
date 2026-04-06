import { NextResponse } from "next/server";
import { getCryptoPrices } from "@repo/shared/utils/crypto-price";
import { Logger } from "@repo/shared";

const logger = new Logger({ serviceName: 'table-stack' });

/**
 * Crypto Price Oracle API Endpoint
 *
 * Server-side endpoint that fetches crypto prices from the shared oracle.
 * Replaces direct CoinGecko calls from client-side components.
 *
 * Benefits:
 * - Centralized price fetching (no CORS issues)
 * - Redis caching (reduced API rate limits)
 * - Fail-closed behavior (no hardcoded prices)
 * - Adblocker-proof (not blocked by CoinGecko filters)
 *
 * GET /api/prices
 * Returns: { ETH: number, MATIC: number, timestamp: number }
 */
export async function GET() {
  try {
    const prices = await getCryptoPrices();
    return NextResponse.json(prices);
  } catch (error) {
    logger.error('Failed to fetch crypto prices', { error: error instanceof Error ? error.message : String(error) });

    // Return specific error code for client handling
    if ((error as any).code === "PRICE_ORACLE_UNAVAILABLE") {
      return NextResponse.json(
        {
          error: "Price oracle unavailable",
          message: "Unable to fetch current crypto prices. Please try again later.",
        },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Failed to fetch prices",
      },
      { status: 500 }
    );
  }
}
