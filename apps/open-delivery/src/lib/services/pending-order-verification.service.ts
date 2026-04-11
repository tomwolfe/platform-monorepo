import { getDb, orders, restaurants, eq, and, sql } from "@repo/database";
import {
  RealtimeService,
  Logger,
  QStashService,
  AppConfig,
} from "@repo/shared";
import { verifyTransaction } from "@repo/shared/utils/web3-verification";
import { type Address, isHex, isAddress } from "viem";
import { processStuckTransactions } from "@repo/shared/services/transaction-speedup";
import { trace, Span, SpanStatusCode } from "@opentelemetry/api";
import { NextRequest, NextResponse } from "next/server";

const tracer = trace.getTracer("open-delivery-pending-verification-service");
const logger = new Logger({ serviceName: "pending-verification-service" });

const QSTASH_HOP_HEADER = "x-qstash-hop-count";
const MAX_QSTASH_HOP_COUNT = 5;
const BATCH_SIZE = 2;

// ============================================================================
// SAFE HEX VALIDATION
// ============================================================================

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

function safeValidateAddress(value: string | null | undefined): Address | null {
  if (!value || !isAddress(value)) {
    return null;
  }
  return value as Address;
}

// ============================================================================
// TYPES
// ============================================================================

export interface VerificationResult {
  success: boolean;
  verifiedCount: number;
  failedCount: number;
  processedCount: number;
}

export interface PendingOrder {
  id: string;
  paymentTxHash: string | null;
  walletAddress: string | null;
  paymentCurrency: string | null;
  subtotal: string | null;
  tip: string | null;
  total: string | null;
  userId: string | null;
  storeId: string | null;
  deliveryAddress: string | null;
  pickupAddress: string | null;
  status: string | null;
  createdAt: Date | null;
  restaurant: {
    id: string | null;
    name: string | null;
    walletAddress: string | null;
  } | null;
}

// ============================================================================
// PENDING ORDER VERIFICATION SERVICE
// ============================================================================

export class PendingOrderVerificationService {
  /**
   * Process pending orders that need Web3 verification.
   * Handles batch processing with QStash self-trigger for serverless timeout safety.
   */
  async processPendingOrders(
    req: NextRequest,
    maxOrdersPerRun: number = 15,
  ): Promise<NextResponse> {
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

    return tracer.startActiveSpan(
      "verify-pending-sweep",
      async (span: Span) => {
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
          const pendingOrders = await this.queryPendingOrders(maxOrdersPerRun);

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
          const hasMoreOrders = pendingOrders.length >= maxOrdersPerRun;
          if (hasMoreOrders) {
            await this.scheduleQStashSelfTrigger(
              req,
              currentHopCount,
              "verify-pending",
            );
          }

          span.setAttribute("cron.pending_orders_found", pendingOrders.length);
          logger.info("Found pending orders to verify", {
            pendingCount: pendingOrders.length,
          });

          // Process orders in parallel batches
          const result = await this.processBatchVerifications(
            pendingOrders,
            traceId,
          );

          span.setAttributes({
            "cron.verified_count": result.verifiedCount,
            "cron.failed_count": result.failedCount,
          });
          span.setStatus({ code: SpanStatusCode.OK });

          const response = {
            success: true,
            message: `Verified ${result.verifiedCount} orders, ${result.failedCount} failed`,
            verifiedCount: result.verifiedCount,
            failedCount: result.failedCount,
            processedCount: pendingOrders.length,
            timestamp: new Date().toISOString(),
          };

          logger.info("Verification sweep completed", {
            verifiedCount: result.verifiedCount,
            failedCount: result.failedCount,
            processedCount: pendingOrders.length,
          });

          return NextResponse.json(response);
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
      },
    );
  }

  /**
   * Query pending orders that need verification.
   */
  private async queryPendingOrders(limit: number): Promise<PendingOrder[]> {
    return getDb()
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
          eq(orders.status, "pending_verification"),
        ),
      )
      .limit(limit);
  }

  /**
   * Schedule QStash self-trigger for remaining orders.
   */
  private async scheduleQStashSelfTrigger(
    req: NextRequest,
    currentHopCount: number,
    endpoint: "verify-pending" | "verify-payouts",
  ): Promise<void> {
    const traceId = req.headers.get("x-trace-id") || undefined;
    const nextHopCount = currentHopCount + 1;
    const appUrl = AppConfig.getNextPublicAppUrl();
    const cronSecret = AppConfig.getCronSecret();

    if (!appUrl || !cronSecret) {
      throw new Error(
        "NEXT_PUBLIC_APP_URL and CRON_SECRET are required for QStash self-trigger",
      );
    }

    await QStashService.publish({
      url: `${appUrl}/api/cron/${endpoint}`,
      body: JSON.stringify({ triggeredBy: "qstash-self-trigger" }),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cronSecret}`,
        ...(traceId ? { "x-trace-id": traceId } : {}),
        [QSTASH_HOP_HEADER]: String(nextHopCount),
      },
    }).catch((err) => {
      logger.warn(
        "Failed to schedule QStash self-trigger for remaining orders",
        {
          error: err instanceof Error ? err.message : String(err),
          hopCount: nextHopCount,
        },
      );
    });
  }

  /**
   * Process batch verifications for pending orders.
   */
  private async processBatchVerifications(
    pendingOrders: PendingOrder[],
    _traceId?: string,
  ): Promise<VerificationResult> {
    let verifiedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < pendingOrders.length; i += BATCH_SIZE) {
      const batch = pendingOrders.slice(i, i + BATCH_SIZE);
      logger.info("Processing verification batch", {
        batchNumber: Math.floor(i / BATCH_SIZE) + 1,
        batchSize: batch.length,
      });

      const batchPromises = batch.map(async (order) => {
        try {
          const totalBigInt = BigInt(order.total);

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
            order.restaurant?.walletAddress,
          );
          if (!recipientAddress) {
            logger.warn(
              "Order has invalid recipient address, marking as failed",
              { orderId: order.id },
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
            await getDb()
              .update(orders)
              .set({ status: "verification_failed" })
              .where(eq(orders.id, order.id));
            return { orderId: order.id, success: false };
          }

          // Transaction verified successfully - update order and dispatch driver
          await getDb()
            .update(orders)
            .set({ status: "pending" })
            .where(eq(orders.id, order.id));

          // Publish Ably event to dispatch driver
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
              items: [],
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
                  dbError instanceof Error ? dbError.message : String(dbError),
              },
            );
          }
          return { orderId: order.id, success: false };
        }
      });

      const batchResults = await Promise.allSettled(batchPromises);

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

    return {
      success: true,
      verifiedCount,
      failedCount,
      processedCount: pendingOrders.length,
    };
  }
}
