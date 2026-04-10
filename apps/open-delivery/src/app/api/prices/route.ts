import { NextResponse } from "next/server";
import { getCryptoPrices } from "@repo/shared/utils/crypto-price";
import { withUnifiedApiHandler, formatApiSuccess } from "@repo/shared";

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
async function getHandler() {
  const prices = await getCryptoPrices();
  return NextResponse.json(formatApiSuccess(prices));
}

export const GET = withUnifiedApiHandler(getHandler, { serviceName: "prices" });
