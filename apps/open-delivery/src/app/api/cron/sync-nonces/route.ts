import { NextRequest, NextResponse } from "next/server";
import {
  withCronAuth,
  Logger,
  getPublicClient,
  getEscrowResolverAddress,
  syncNonceFromChain,
  checkNonceSyncStatus,
  formatError,
  formatSuccess,
} from "@repo/shared";
import { base } from "viem/chains";

export const runtime = "nodejs";
export const maxDuration = 10; // Vercel Hobby limit

const logger = new Logger({ serviceName: "sync-nonces-cron" });

/**
 * Nonce Sync Cron Endpoint
 *
 * PROBLEM SOLVED:
 * - If a transaction fails after nonce increment but before broadcast confirmation,
 *   the Redis nonce tracker may drift from the on-chain nonce
 * - This causes "nonce too low" errors on subsequent transactions
 *
 * SOLUTION:
 * - Runs hourly via QStash
 * - Checks the escrow resolver wallet's on-chain nonce
 * - Resets the Redis nonce tracker if drift is detected
 * - Logs warnings if significant drift is found (indicates stuck transactions)
 *
 * SECURITY:
 * - Requires CRON_SECRET header for authentication
 * - Read-only operation (no state mutations on contracts)
 *
 * Usage:
 * POST /api/cron/sync-nonces
 * Headers:
 *   Authorization: Bearer <CRON_SECRET>
 */
async function postHandler(_req: NextRequest) {
  try {
    logger.info({ message: "Starting nonce sync cron" });

    const chainId = base.id;
    const publicClient = await getPublicClient(chainId);
    const resolverAddress = await getEscrowResolverAddress();

    // Check sync status
    const syncStatus = await checkNonceSyncStatus(
      chainId,
      resolverAddress,
      publicClient,
    );

    logger.info({
      message: "Nonce sync status check",
      ...syncStatus,
    });

    if (syncStatus.isSynced) {
      return NextResponse.json(
        formatSuccess({
          message: "Nonce tracker is already in sync",
          chainId,
          resolverAddress,
          trackedNonce: syncStatus.trackedNonce,
          onChainNonce: syncStatus.onChainNonce,
          synced: true,
          timestamp: new Date().toISOString(),
        }),
      );
    }

    // Sync needed - reset tracker to on-chain value
    const syncedNonce = await syncNonceFromChain(
      chainId,
      resolverAddress,
      publicClient,
    );

    logger.info({
      message: "Nonce tracker synced with on-chain value",
      chainId,
      resolverAddress,
      syncedNonce,
    });

    return NextResponse.json(
      formatSuccess({
        message: "Nonce tracker synced successfully",
        chainId,
        resolverAddress,
        previousTrackedNonce: syncStatus.trackedNonce,
        syncedNonce,
        onChainNonce: syncStatus.onChainNonce,
        syncReason: syncStatus.reason,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch (error) {
    logger.error({
      message: "Nonce sync cron failed",
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(formatError(error, "EXTERNAL_SERVICE_ERROR"), {
      status: 500,
    });
  }
}

async function getHandler(_req: NextRequest) {
  return NextResponse.json({
    status: "ok",
    message: "Nonce sync cron endpoint is healthy",
    endpoint: "/api/cron/sync-nonces",
  });
}

// Wrap handlers with cron authentication
export const POST = withCronAuth(async (req: NextRequest) => {
  return postHandler(req);
});

export const GET = withCronAuth(async (req: NextRequest) => {
  return getHandler(req);
});
