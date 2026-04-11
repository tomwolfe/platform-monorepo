import { NextRequest, NextResponse } from "next/server";
import { getDb, orders, restaurants, eq, and, sql } from "@repo/database";
import {
  RealtimeService,
  withUnifiedApiHandler,
  withCronAuth,
  Logger,
  withDistributedLock,
  QStashService,
  AppConfig,
} from "@repo/shared";
import { verifyTransaction } from "@repo/shared/utils/web3-verification";
import { type Address, isHex, isAddress } from "viem";
import { processStuckTransactions } from "@repo/shared/services/transaction-speedup";
import { trace, Span, SpanStatusCode } from "@opentelemetry/api";

export const maxDuration = 10; // Vercel Hobby limit

const logger = new Logger({ serviceName: "verify-pending-cron" });
const tracer = trace.getTracer("open-delivery-cron");

// ============================================================================
// SAFE HEX VALIDATION
// ============================================================================

/**
 * Safely validate a hex string for use as a transaction hash.
 * Returns null if invalid so the caller can mark the order as failed.
 */
function safeValidateHex(
  value: string | null,
  label: string,
): `0x${string}` | null {
  if (!value || !isHex(value)) {
    logger.warn(`Invalid hex for ${label}`, { value });
    return null;
  }
  return value as `0x${string}`;
}

/**
 * Safely validate an Ethereum address.
 * Returns null if invalid.
 */
function safeValidateAddress(value: string | null | undefined): Address | null {
  if (!value || !isAddress(value)) {
    return null;
  }
  return value as Address;
}

// SERVERLESS RESILIENCE: Reduced from 50 to 15 to stay within Vercel's 10s limit.
// If more than 15 orders exist, a QStash self-trigger recursively processes the rest.
const MAX_ORDERS_PER_RUN = 15;

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

// RELIABILITY FIX: Process orders in batches to avoid RPC rate limits
// REDUCED BATCH SIZE: From 5 to 2 to ensure we stay within Vercel's 10s maxDuration
// even with RPC fallbacks and rate limiting. QStash self-trigger handles remaining orders.
const BATCH_SIZE = 2;

// CRITICAL FIX: Prevent infinite QStash recursive loops
// If a batch of orders consistently fails, the hop count will halt self-triggering
const MAX_QSTASH_HOP_COUNT = 5;
const QSTASH_HOP_HEADER = "x-qstash-hop-count";

async function postHandler(req: NextRequest) {
  const traceId = req.headers.get("x-trace-id") || undefined;
  const hopCountHeader = req.headers.get(QSTASH_HOP_HEADER);
  const currentHopCount = hopCountHeader ? parseInt(hopCountHeader, 10) : 0;
  const requestLogger = traceId
    ? logger.child({ traceId, hopCount: currentHopCount })
    : logger;

  // CRITICAL: Halt if hop count exceeds threshold to prevent infinite loops
  if (currentHopCount > MAX_QSTASH_HOP_COUNT) {
    requestLogger.error(
      `QStash self-trigger hop count exceeded (${currentHopCount}/${MAX_QSTASH_HOP_COUNT}). Halting to prevent infinite loop.`,
    );
    return NextResponse.json(
      {
        success: false,
        error: "QStash hop count exceeded",
        hopCount: currentHopCount,
        message: `Self-triggering halted after ${currentHopCount} hops to prevent infinite loop`,
      },
      { status: 500 },
    );
  }

  requestLogger.info("Starting background verification sweep");

  return tracer.startActiveSpan("verify-pending-sweep", async (span: Span) => {
    try {
      if (traceId) {
        span.setAttribute("http.request.trace_id", traceId);
      }

      // WEB3 RESILIENCE: Process stuck transactions and speed them up
      const speedUpResult = await processStuckTransactions({
        maxTransactions: 10,
      });
      if (speedUpResult.speedUpCount > 0) {
        requestLogger.info("Sped up stuck transactions", {
          speedUpCount: speedUpResult.speedUpCount,
          failedCount: speedUpResult.failedCount,
        });
        span.setAttribute(
          "cron.stuck_transactions_speeded_up",
          speedUpResult.speedUpCount,
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
            eq(orders.status, "pending_verification"), // New intermediate state
          ),
        )
        .limit(MAX_ORDERS_PER_RUN); // Process up to MAX_ORDERS_PER_RUN orders per sweep

      if (pendingOrders.length === 0) {
        span.setAttribute("cron.pending_orders_found", 0);
        span.setStatus({ code: SpanStatusCode.OK });
        return NextResponse.json({
          success: true,
          message: "No pending orders to verify",
          verifiedCount: 0,
        });
      }

      // QSTASH SELF-TRIGGER: If we hit the batch limit, schedule another run
      // to process remaining orders without exceeding the 10s serverless timeout.
      const hasMoreOrders = pendingOrders.length >= MAX_ORDERS_PER_RUN;
      if (hasMoreOrders) {
        const traceId = req.headers.get("x-trace-id") || undefined;
        const nextHopCount = currentHopCount + 1;
        const appUrl = AppConfig.getNextPublicAppUrl();
        const cronSecret = AppConfig.getCronSecret();
        if (!appUrl || !cronSecret) {
          throw new Error(
            "NEXT_PUBLIC_APP_URL and CRON_SECRET are required for QStash self-trigger",
          );
        }
        QStashService.publish({
          url: `${appUrl}/api/cron/verify-pending`,
          body: JSON.stringify({ triggeredBy: "qstash-self-trigger" }),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cronSecret}`,
            ...(traceId ? { "x-trace-id": traceId } : {}),
            [QSTASH_HOP_HEADER]: String(nextHopCount),
          },
        }).catch((err) => {
          requestLogger.warn(
            "Failed to schedule QStash self-trigger for remaining orders",
            {
              error: err instanceof Error ? err.message : String(err),
              hopCount: nextHopCount,
            },
          );
        });
      }

      span.setAttribute("cron.pending_orders_found", pendingOrders.length);
      logger.info("Found pending orders to verify", {
        pendingCount: pendingOrders.length,
      });

      let verifiedCount = 0;
      let failedCount = 0;

      // PERFORMANCE FIX: Process orders in parallel batches to avoid serverless timeout
      // Vercel serverless functions have a 10-30s timeout limit
      // Processing 50 orders sequentially with RPC calls would exceed this limit
      for (let i = 0; i < pendingOrders.length; i += BATCH_SIZE) {
        const batch = pendingOrders.slice(i, i + BATCH_SIZE);
        logger.info("Processing verification batch", {
          batchNumber: Math.floor(i / BATCH_SIZE) + 1,
          batchSize: batch.length,
        });

        const batchPromises = batch.map(async (order) => {
          try {
            // Move BigInt casting inside try block to catch parsing errors
            const totalBigInt = BigInt(order.total);
            const _tipBigInt = BigInt(order.tip); // Reserved for future tip-based verification

            // Safely validate hex strings before verification
            const txHashHex = safeValidateHex(
              order.paymentTxHash,
              "paymentTxHash",
            );
            if (!txHashHex) {
              logger.warn("Order has invalid tx hash hex, marking as failed", {
                orderId: order.id,
              });
              await getDb()
                .update(orders)
                .set({ status: "verification_failed" })
                .where(eq(orders.id, order.id));
              return { orderId: order.id, success: false };
            }

            const recipientAddress = safeValidateAddress(
              order.restaurant.walletAddress,
            );
            if (!recipientAddress) {
              logger.warn(
                "Order has invalid recipient address, marking as failed",
                {
                  orderId: order.id,
                },
              );
              await getDb()
                .update(orders)
                .set({ status: "verification_failed" })
                .where(eq(orders.id, order.id));
              return { orderId: order.id, success: false };
            }

            // Verify the transaction on-chain
            const verificationResult = await verifyTransaction({
              txHash: txHashHex,
              expectedValue: totalBigInt,
              expectedRecipient: recipientAddress,
              paymentCurrency: order.paymentCurrency || "USDC",
            });

            if (!verificationResult.success) {
              logger.warn("Order verification failed", {
                orderId: order.id,
                error: verificationResult.error,
              });
              // POISON PILL FIX: Mark as verification_failed so the queue can proceed
              await getDb()
                .update(orders)
                .set({ status: "verification_failed" })
                .where(eq(orders.id, order.id));
              return { orderId: order.id, success: false };
            }

            // Transaction verified successfully!
            // Update order status and dispatch driver
            await getDb()
              .update(orders)
              .set({
                status: "pending", // Now move to normal pending state
              })
              .where(eq(orders.id, order.id));

            // Publish Ably event to dispatch driver (same as frontend checkout)
            await RealtimeService.publish(
              "nervous-system:updates",
              "delivery.intent_created",
              {
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
              },
            );

            logger.info("Order verified and driver dispatched", {
              orderId: order.id,
            });
            return { orderId: order.id, success: true };
          } catch (error: unknown) {
            logger.error("Error verifying order", {
              orderId: order.id,
              error: error instanceof Error ? error.message : String(error),
            });
            // POISON PILL FIX: Mark as verification_failed so the queue can proceed
            try {
              await getDb()
                .update(orders)
                .set({ status: "verification_failed" })
                .where(eq(orders.id, order.id));
            } catch (dbError) {
              logger.error(
                "Failed to update order status to verification_failed",
                {
                  orderId: order.id,
                  error:
                    dbError instanceof Error
                      ? dbError.message
                      : String(dbError),
                },
              );
            }
            return { orderId: order.id, success: false };
          }
        });

        // Wait for batch to complete
        const batchResults = await Promise.allSettled(batchPromises);

        // Count results
        for (const result of batchResults) {
          if (result.status === "fulfilled" && result.value.success) {
            verifiedCount++;
          } else {
            failedCount++;
          }
        }

        // Small delay between batches to avoid RPC rate limiting
        if (i + BATCH_SIZE < pendingOrders.length) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      span.setAttributes({
        "cron.verified_count": verifiedCount,
        "cron.failed_count": failedCount,
      });
      span.setStatus({ code: SpanStatusCode.OK });

      const result = {
        success: true,
        message: `Verified ${verifiedCount} orders, ${failedCount} failed`,
        verifiedCount,
        failedCount,
        processedCount: pendingOrders.length,
        timestamp: new Date().toISOString(),
      };

      logger.info("Verification sweep completed", {
        verifiedCount,
        failedCount,
        processedCount: pendingOrders.length,
      });

      return NextResponse.json(result);
    } catch (error: unknown) {
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      );
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function getHandler(_req: NextRequest) {
  return NextResponse.json({
    status: "ok",
    message: "Verify pending cron endpoint is healthy",
    endpoint: "/api/cron/verify-pending",
  });
}

// Wrap handlers with cron authentication and distributed lock
export const POST = withCronAuth(
  withUnifiedApiHandler(
    async (req: NextRequest) => {
      const lockKey = "cron:open-delivery:verify-pending";
      const lockTtlSeconds = 120; // 2 minutes for batch processing

      try {
        return await withDistributedLock(lockKey, lockTtlSeconds, async () =>
          postHandler(req),
        );
      } catch (error) {
        // If lock acquisition fails, return 200 OK to indicate graceful skip
        if (
          error instanceof Error &&
          error.message.includes("Failed to acquire distributed lock")
        ) {
          logger.info(
            "Verify-pending cron skipped - another instance is running",
          );
          return NextResponse.json({
            success: true,
            skipped: true,
            message: "Another instance is running",
          });
        }
        throw error;
      }
    },
    { serviceName: "verify-pending-cron" },
  ),
);
export const GET = withCronAuth(
  withUnifiedApiHandler(getHandler, { serviceName: "verify-pending-cron" }),
);
