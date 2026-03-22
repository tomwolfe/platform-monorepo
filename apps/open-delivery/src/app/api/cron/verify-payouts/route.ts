import { NextRequest, NextResponse } from 'next/server';
import { db, orders, eq, and, isNotNull, inArray } from "@repo/database";
import { createPublicClient, http, fallback, type Address } from 'viem';
import { base } from 'viem/chains';
import { timingSafeEqual } from 'crypto';

/**
 * Timing-safe secret comparison to prevent timing attacks
 */
function isTimingSafeEqual(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  
  // Pad to same length to avoid timingSafeEqual errors
  const maxLength = Math.max(providedBuffer.length, expectedBuffer.length);
  const paddedProvided = Buffer.alloc(maxLength);
  const paddedExpected = Buffer.alloc(maxLength);
  
  providedBuffer.copy(paddedProvided);
  expectedBuffer.copy(paddedExpected);
  
  try {
    return timingSafeEqual(paddedProvided, paddedExpected);
  } catch {
    return false;
  }
}

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

const CRON_SECRET = process.env.CRON_SECRET;

// Maximum orders to verify per run (prevent timeout)
const MAX_ORDERS_PER_RUN = 50;

export async function GET(req: NextRequest) {
  try {
    // Verify cron authentication
    const authHeader = req.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Missing or invalid authorization header' },
        { status: 401 }
      );
    }

    const providedSecret = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    // TIMING-SAFE COMPARISON: Prevents timing attacks on secret validation
    if (!CRON_SECRET || !isTimingSafeEqual(providedSecret, CRON_SECRET)) {
      console.warn('[Verify Payouts Cron] Invalid cron secret provided');
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

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

    // CRITICAL: Use Promise.all for parallel verification (not sequential)
    // This prevents the 10-second timeout issue
    const verificationPromises = processingPayouts.map(async (order: { id: string; payoutTxHash: string | null; payoutStatus: string | null }) => {
      try {
        const hash = order.payoutTxHash as `0x${string}`;
        
        // Get transaction receipt (non-blocking, parallel execution)
        const receipt = await publicClient.getTransactionReceipt({ hash });

        if (receipt.status === 'success') {
          console.log(`[Verify Payouts Cron] Payout confirmed on-chain: ${order.id}`);
          
          // Mark as completed
          await db.update(orders)
            .set({
              payoutStatus: 'completed',
              payoutProcessedAt: new Date(),
            })
            .where(eq(orders.id, order.id));
          
          return { orderId: order.id, status: 'completed' };
        } else {
          console.error(`[Verify Payouts Cron] Payout reverted on-chain: ${order.id}`);
          
          // Mark as failed
          await db.update(orders)
            .set({ payoutStatus: 'failed' })
            .where(eq(orders.id, order.id));
          
          return { orderId: order.id, status: 'failed', reason: 'reverted' };
        }
      } catch (error) {
        // Transaction not found yet (still pending) - leave as processing
        // It will be picked up on the next cron run
        console.log(`[Verify Payouts Cron] Payout still pending: ${order.id} - ${error instanceof Error ? error.message : 'Unknown error'}`);
        return { orderId: order.id, status: 'pending' };
      }
    });

    // Wait for all verifications to complete
    const results = await Promise.all(verificationPromises);

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
export async function POST(req: NextRequest) {
  return GET(req);
}
