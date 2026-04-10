import { NextResponse } from "next/server";
import { getCryptoPrices } from "@repo/shared/utils/crypto-price";
import { Logger } from "@repo/shared";
import { formatApiSuccess, formatApiError } from "@repo/shared";

const logger = new Logger({ serviceName: "table-stack" });

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
 * Returns: { success: true, data: { ETH: number, MATIC: number, timestamp: number } }
 */
export async function GET() {
  try {
    const prices = await getCryptoPrices();
    return NextResponse.json(formatApiSuccess(prices));
  } catch (error) {
    logger.error("Failed to fetch crypto prices", {
      error: error instanceof Error ? error.message : String(error),
    });

    // Return specific error code for client handling
    const errorCode =
      error instanceof Error && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (errorCode === "PRICE_ORACLE_UNAVAILABLE") {
      return NextResponse.json(
        formatApiError(
          new Error("Price oracle unavailable"),
          "EXTERNAL_SERVICE_ERROR",
        ),
        { status: 503 },
      );
    }

    return NextResponse.json(formatApiError(error, "INTERNAL_ERROR"), {
      status: 500,
    });
  }
}
