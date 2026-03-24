import { NextRequest, NextResponse } from 'next/server';
import { getDb, orders, restaurants, eq, and, sql } from "@repo/database";
import { RealtimeService, withApiErrorHandler } from "@repo/shared";
import { verifyTransaction } from '@repo/shared/utils/web3-verification';
import { type Address } from 'viem';
import { isTimingSafeEqual } from '@repo/shared/utils/crypto';
import { processStuckTransactions } from '@repo/shared/services/transaction-speedup';

/**
 * Background Verification Sweeper Endpoint
 *
 * PROBLEM SOLVED:
 * - Users pay on mobile, then close browser before confirmation
 * - Money is taken, but order never confirmed (no Ably event dispatched)
 *
 * SOLUTION:
 * - Cron runs every 5 minutes via QStash
 * - Queries orders with paymentTxHash but status = 'pending_verification'
 * - Verifies transactions asynchronously on-chain
 * - Confirms orders and dispatches drivers even if user is offline
 *
 * SECURITY:
 * - Requires CRON_SECRET header for authentication
 * - Idempotent: only processes pending verification orders
 *
 * Usage:
 * POST /api/cron/verify-pending
 * Headers:
 *   Authorization: Bearer <CRON_SECRET>
 */

const CRON_SECRET = process.env.CRON_SECRET;

// RELIABILITY FIX: Process orders in batches to avoid RPC rate limits
const BATCH_SIZE = 5;
const MAX_ORDERS_PER_RUN = 50;

async function postHandler(req: NextRequest) {
  // Verify cron authentication
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Missing or invalid authorization header' },
      { status: 401 }
    );
  }

  const providedSecret = authHeader.substring(7);

  // TIMING-SAFE COMPARISON: Prevents timing attacks on secret validation
  if (!CRON_SECRET || !isTimingSafeEqual(providedSecret, CRON_SECRET)) {
    console.warn('[Verify Pending Cron] Invalid cron secret provided');
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  console.log('[Verify Pending Cron] Starting background verification sweep...');

  // WEB3 RESILIENCE: Process stuck transactions and speed them up
  const speedUpResult = await processStuckTransactions({ maxTransactions: 10 });
  if (speedUpResult.speedUpCount > 0) {
    console.log(
      `[Verify Pending Cron] Sped up ${speedUpResult.speedUpCount} stuck transactions ` +
      `(${speedUpResult.failedCount} failed)`
    );
  }

  // Query orders that have payment hash but are still pending verification
  // These are orders where the user paid but may have closed browser
  const pendingOrders = await getDb()
    .select({
      id: orders.id,
      paymentTxHash: orders.paymentTxHash,
      walletAddress: orders.walletAddress,
      paymentCurrency: orders.paymentCurrency,
      subtotal: orders.subtotal,
      tip: orders.tip,
      total: orders.total,
      userId: orders.userId,
      storeId: orders.storeId,
      deliveryAddress: orders.deliveryAddress,
      pickupAddress: orders.pickupAddress,
      status: orders.status,
      createdAt: orders.createdAt,
      restaurant: {
        id: restaurants.id,
        name: restaurants.name,
        walletAddress: restaurants.walletAddress,
      },
    })
    .from(orders)
    .leftJoin(restaurants, eq(orders.storeId, restaurants.id))
    .where(
      and(
        sql`${orders.paymentTxHash} IS NOT NULL`,
        eq(orders.status, 'pending_verification'), // New intermediate state
      )
    )
    .limit(50); // Process up to 50 orders per sweep

  if (pendingOrders.length === 0) {
    return NextResponse.json({
      success: true,
      message: 'No pending orders to verify',
      verifiedCount: 0,
    });
  }

  console.log(`[Verify Pending Cron] Found ${pendingOrders.length} pending orders to verify`);

  let verifiedCount = 0;
  let failedCount = 0;

  for (const order of pendingOrders) {
    try {
      // Verify the transaction on-chain
      const verificationResult = await verifyTransaction({
        txHash: order.paymentTxHash as `0x${string}`,
        expectedValue: BigInt(order.total),
        expectedRecipient: order.restaurant.walletAddress as Address | undefined,
        paymentCurrency: order.paymentCurrency || 'USDC',
      });

      if (!verificationResult.success) {
        console.warn(`[Verify Pending Cron] Order ${order.id} verification failed:`, verificationResult.error);
        failedCount++;
        continue;
      }

      // Transaction verified successfully!
      // Update order status and dispatch driver
      await getDb().update(orders)
        .set({
          status: 'pending', // Now move to normal pending state
        })
        .where(eq(orders.id, order.id));

      // Publish Ably event to dispatch driver (same as frontend checkout)
      await RealtimeService.publish("nervous-system:updates", "delivery.intent_created", {
        orderId: order.id,
        fulfillmentId: order.id,
        pickupAddress: order.pickupAddress,
        deliveryAddress: order.deliveryAddress,
        price: order.total,
        priority: "standard",
        items: [], // Items would need to be fetched from orderItems table
        timestamp: new Date().toISOString(),
        traceId: `order-${order.id}`,
        payment: {
          txHash: order.paymentTxHash,
          currency: order.paymentCurrency,
          walletAddress: order.walletAddress,
        },
      });

      console.log(`[Verify Pending Cron] Order ${order.id} verified and driver dispatched`);
      verifiedCount++;

    } catch (error) {
      console.error(`[Verify Pending Cron] Error verifying order ${order.id}:`, error);
      failedCount++;
    }
  }

  const result = {
    success: true,
    message: `Verified ${verifiedCount} orders, ${failedCount} failed`,
    verifiedCount,
    failedCount,
    processedCount: pendingOrders.length,
    timestamp: new Date().toISOString(),
  };

  console.log('[Verify Pending Cron] Sweep completed:', result);

  return NextResponse.json(result);
}

async function getHandler(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Missing or invalid authorization header' },
      { status: 401 }
    );
  }

  const providedSecret = authHeader.substring(7);

  // TIMING-SAFE COMPARISON: Prevents timing attacks on secret validation
  if (!CRON_SECRET || !isTimingSafeEqual(providedSecret, CRON_SECRET)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  return NextResponse.json({
    status: 'ok',
    message: 'Verify pending cron endpoint is healthy',
    endpoint: '/api/cron/verify-pending',
  });
}

export const POST = withApiErrorHandler(postHandler, 'EXECUTION_FAILED');
export const GET = withApiErrorHandler(getHandler, 'EXECUTION_FAILED');
