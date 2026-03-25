import { NextRequest, NextResponse } from 'next/server';
import { getDb, orders, eq, and, isNotNull, inArray } from "@repo/database";
import { createPublicClient, http, fallback, type Address } from 'viem';
import { base } from 'viem/chains';
import { withCronAuth } from '@repo/shared';

/**
 * Verify Payouts Cron Endpoint
 *
 * ASYNCHRONOUS PAYOUT VERIFICATION FOR OPEN-DELIVERY
 *
 * Problem Solved:
 * - Vercel serverless has a 10-second timeout
 * - Waiting for transaction receipts sequentially (2s per block on Base) causes timeouts
 * - Solution: Split payout execution into two phases:
 *   1. /api/cron/payouts - Submits transactions, saves tx hash, marks as 'processing'
 *   2. /api/cron/verify-payouts - Confirms receipts asynchronously (runs every 5 min)
 *
 * What it does:
 * 1. Queries all orders with payoutStatus = 'processing' and payoutTxHash set
 * 2. Uses Promise.all to check receipts in parallel (not sequential)
 * 3. Marks orders as 'completed' or 'failed' based on receipt status
 *
 * Security:
 * - Requires CRON_SECRET header for authentication
 * - Idempotent: only processes 'processing' payouts
 *
 * Usage:
 * GET /api/cron/verify-payouts
 * Headers:
 *   Authorization: Bearer <CRON_SECRET>
 */

// Maximum orders to verify per run (prevent timeout)
const MAX_ORDERS_PER_RUN = 50;

async function getCronHandler(req: NextRequest) {
  try {

    console.log('[Verify Payouts Cron] Starting async verification...');

    // Query all orders with processing payouts that have a tx hash
    const processingPayouts = await db
      .select({
        id: orders.id,
        payoutTxHash: orders.payoutTxHash,
        payoutStatus: orders.payoutStatus,
      })
      .from(orders)
      .where(
        and(
          eq(orders.payoutStatus, 'processing'),
          isNotNull(orders.payoutTxHash),
        )
      )
      .limit(MAX_ORDERS_PER_RUN);

    if (processingPayouts.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No processing payouts to verify',
        verifiedCount: 0,
        completedCount: 0,
        failedCount: 0,
      });
    }

    console.log(`[Verify Payouts Cron] Found ${processingPayouts.length} payouts to verify`);

    // RPC URLs with fallbacks for resilience
    const BASE_RPC_URLS = [
      process.env.BASE_RPC_URL || "https://mainnet.base.org",
      "https://base.llamarpc.com",
      "https://base.publicnode.com",
    ];

    // Create public client for checking receipts
    const publicClient = createPublicClient({
      chain: base,
      transport: fallback(BASE_RPC_URLS.map((url) => http(url))),
    });

    // RELIABILITY FIX: Process verifications in batches to avoid RPC rate limits
    // Public RPC nodes (like mainnet.base.org) will return 429 Too Many Requests
    // when hit with 50 concurrent requests. Process in batches of 5.
    const BATCH_SIZE = 5;
    const results: Array<{ orderId: string; status: 'completed' | 'failed' | 'pending'; reason?: string; error?: string }> = [];

    // Process in batches
    for (let i = 0; i < processingPayouts.length; i += BATCH_SIZE) {
      const batch = processingPayouts.slice(i, i + BATCH_SIZE);
      console.log(`[Verify Payouts Cron] Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} payouts)`);

      const batchPromises = batch.map(async (order: { id: string; payoutTxHash: string | null; payoutStatus: string | null }) => {
        try {
          const hash = order.payoutTxHash as `0x${string}`;

          // Get transaction receipt (parallel within batch)
          const receipt = await publicClient.getTransactionReceipt({ hash });

          if (receipt.status === 'success') {
            console.log(`[Verify Payouts Cron] Payout confirmed on-chain: ${order.id}`);

            // Mark as completed
            await getDb().update(orders)
              .set({
                payoutStatus: 'completed',
                payoutProcessedAt: new Date(),
              })
              .where(eq(orders.id, order.id));

            return { orderId: order.id, status: 'completed' as const };
          } else {
            console.error(`[Verify Payouts Cron] Payout reverted on-chain: ${order.id}`);

            // Mark as failed
            await getDb().update(orders)
              .set({ payoutStatus: 'failed' })
              .where(eq(orders.id, order.id));

            return { orderId: order.id, status: 'failed' as const, reason: 'reverted' };
          }
        } catch (error) {
          // Transaction not found yet (still pending) - leave as processing
          // It will be picked up on the next cron run
          console.log(`[Verify Payouts Cron] Payout still pending: ${order.id} - ${error instanceof Error ? error.message : 'Unknown error'}`);
          return { orderId: order.id, status: 'pending' as const };
        }
      });

      // Wait for batch to complete before starting next batch
      const batchResults = await Promise.allSettled(batchPromises);

      // Process batch results
      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        const order = batch[j];

        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          // Promise rejected - log error and return pending status
          console.error(
            `[Verify Payouts Cron] Verification promise rejected for ${order.id}:`,
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          );
          results.push({ orderId: order.id, status: 'pending' as const, error: 'verification_failed' });
        }
      }

      // Small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < processingPayouts.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // Count results
    const completedCount = results.filter(r => r.status === 'completed').length;
    const failedCount = results.filter(r => r.status === 'failed').length;
    const pendingCount = results.filter(r => r.status === 'pending').length;

    const result = {
      success: true,
      message: `Verified ${completedCount + failedCount} payouts, ${pendingCount} still pending`,
      verifiedCount: completedCount + failedCount,
      completedCount,
      failedCount,
      pendingCount,
      timestamp: new Date().toISOString(),
    };

    console.log('[Verify Payouts Cron] Verification completed:', result);

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Verify Payouts Cron] Critical error:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * POST endpoint to manually trigger verification
 * Useful for testing or manual intervention
 */
async function postCronHandler(req: NextRequest) {
  return getCronHandler(req);
}

// Wrap handlers with cron authentication
export const GET = withCronAuth(getCronHandler);
export const POST = withCronAuth(postCronHandler);
