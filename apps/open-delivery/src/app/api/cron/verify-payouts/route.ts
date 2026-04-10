import { NextRequest, NextResponse } from "next/server";
import { getDb, orders, eq, and, isNotNull, drivers } from "@repo/database";
import { type Address, decodeEventLog } from "viem";
import { getPublicClient } from "@repo/web3";
import { ESCROW_ABI } from "@repo/shared/utils/escrow-abi";
import { withCronAuth, QStashService, Logger, AppConfig } from "@repo/shared";
import { trace, Span, SpanStatusCode } from "@opentelemetry/api";

export const maxDuration = 10; // Vercel Hobby limit

const tracer = trace.getTracer("open-delivery-payouts-cron");
const logger = new Logger({ serviceName: "open-delivery-verify-payouts" });

// SERVERLESS RESILIENCE: Reduced from 50 to 15 to stay within Vercel's 10s limit.
// If more than 15 orders exist, a QStash self-trigger recursively processes the rest.
const MAX_ORDERS_PER_RUN = 15;

// CRITICAL FIX: Prevent infinite QStash recursive loops
// If a batch of orders consistently fails, the hop count will halt self-triggering
const MAX_QSTASH_HOP_COUNT = 5;
const QSTASH_HOP_HEADER = "x-qstash-hop-count";

/**
 * Verify Tip Releases Cron Endpoint
 *
 * ASYNCHRONOUS TIP RELEASE VERIFICATION FOR NON-CUSTODIAL ESCROW
 *
 * How it works:
 * - /api/cron/payouts submits tip release transactions, saves tx hash, marks as 'released'
 * - This cron verifies the on-chain TipReleased event for each release transaction
 * - Confirms the driver actually received their tip from the escrow contract
 *
 * What it does:
 * 1. Queries all orders with escrowStatus = 'released' and payoutTxHash set
 * 2. Checks transaction receipts in parallel
 * 3. Parses TipReleased event logs to verify driver received funds
 * 4. Marks orders as 'completed' or 'failed' based on receipt status
 *
 * Security:
 * - Requires CRON_SECRET header for authentication
 * - Idempotent: only processes 'released' payouts
 *
 * Usage:
 * GET /api/cron/verify-payouts
 * Headers:
 *   Authorization: Bearer <CRON_SECRET>
 */

async function getCronHandler(req: NextRequest) {
  const traceId = req.headers.get("x-trace-id") || undefined;
  const hopCountHeader = req.headers.get(QSTASH_HOP_HEADER);
  const currentHopCount = hopCountHeader ? parseInt(hopCountHeader, 10) : 0;

  // CRITICAL: Halt if hop count exceeds threshold to prevent infinite loops
  if (currentHopCount > MAX_QSTASH_HOP_COUNT) {
    logger.error(
      `[Verify Payouts Cron] QStash self-trigger hop count exceeded (${currentHopCount}/${MAX_QSTASH_HOP_COUNT}). Halting to prevent infinite loop.`,
      { traceId, hopCount: currentHopCount },
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

  return tracer.startActiveSpan("verify-payouts-sweep", async (span: Span) => {
    try {
      if (traceId) {
        span.setAttribute("http.request.trace_id", traceId);
      }

      logger.info(
        "[Verify Payouts Cron] Starting tip release verification...",
        { traceId, hopCount: currentHopCount },
      );

      // Get database connection
      const database = getDb();

      // Query all orders with released escrow status and a tx hash
      const releasedOrders = await database
        .select({
          id: orders.id,
          payoutTxHash: orders.payoutTxHash,
          escrowStatus: orders.escrowStatus,
          tip: orders.tip,
          driverWalletAddress: drivers.walletAddress,
        })
        .from(orders)
        .innerJoin(drivers, eq(orders.driverId, drivers.id))
        .where(
          and(
            eq(orders.escrowStatus, "released"),
            isNotNull(orders.payoutTxHash),
          ),
        )
        .limit(MAX_ORDERS_PER_RUN);

      if (releasedOrders.length === 0) {
        span.setAttribute("cron.released_orders_found", 0);
        span.setStatus({ code: SpanStatusCode.OK });
        return NextResponse.json({
          success: true,
          message: "No released tips to verify",
          verifiedCount: 0,
          completedCount: 0,
          failedCount: 0,
        });
      }

      // QSTASH SELF-TRIGGER: If we hit the batch limit, schedule another run
      // to process remaining orders without exceeding the 10s serverless timeout.
      const hasMoreOrders = releasedOrders.length >= MAX_ORDERS_PER_RUN;
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
          url: `${appUrl}/api/cron/verify-payouts`,
          body: JSON.stringify({ triggeredBy: "qstash-self-trigger" }),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cronSecret}`,
            ...(traceId ? { "x-trace-id": traceId } : {}),
            [QSTASH_HOP_HEADER]: String(nextHopCount),
          },
        }).catch((err) => {
          logger.warn(
            "[Verify Payouts Cron] Failed to schedule QStash self-trigger for remaining orders",
            {
              error: err instanceof Error ? err.message : String(err),
              traceId,
              hopCount: nextHopCount,
            },
          );
        });
      }

      span.setAttribute("cron.released_orders_found", releasedOrders.length);
      logger.info(
        `[Verify Payouts Cron] Found ${releasedOrders.length} tip releases to verify`,
        { traceId },
      );

      // Create public client for checking receipts
      const publicClient = getPublicClient("base");

      // Escrow contract address for event parsing
      const ESCROW_CONTRACT_ADDRESS = process.env
        .NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS as Address;

      // Process verifications in batches to avoid RPC rate limits
      // REDUCED BATCH SIZE: From 5 to 2 to ensure we stay within Vercel's 10s maxDuration
      // even with RPC fallbacks and rate limiting. QStash self-trigger handles remaining orders.
      const BATCH_SIZE = 2;
      const results: Array<{
        orderId: string;
        status: "completed" | "failed" | "pending";
        reason?: string;
        error?: string;
      }> = [];

      // Process in batches
      for (let i = 0; i < releasedOrders.length; i += BATCH_SIZE) {
        const batch = releasedOrders.slice(i, i + BATCH_SIZE);
        logger.info(
          `[Verify Payouts Cron] Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} tip releases)`,
          { traceId },
        );

        const batchPromises = batch.map(
          async (order: {
            id: string;
            payoutTxHash: string | null;
            escrowStatus: string | null;
            tip: string | null;
          }) => {
            try {
              const hash = order.payoutTxHash as `0x${string}`;

              // Get transaction receipt
              const receipt = await publicClient.getTransactionReceipt({
                hash,
              });

              if (receipt.status === "success") {
                // Verify TipReleased event was emitted from escrow contract
                if (ESCROW_CONTRACT_ADDRESS) {
                  const tipReleasedLogs = receipt.logs.filter(
                    (log) =>
                      log.address.toLowerCase() ===
                      ESCROW_CONTRACT_ADDRESS.toLowerCase(),
                  );

                  // Decode and verify each TipReleased event
                  let verifiedEventFound = false;
                  for (const log of tipReleasedLogs) {
                    try {
                      const decoded = decodeEventLog({
                        abi: ESCROW_ABI,
                        data: log.data,
                        topics: log.topics,
                      });

                      if (decoded.eventName === "TipReleased") {
                        const { driver, tipAmount } = decoded.args as {
                          driver: Address;
                          tipAmount: bigint;
                        };

                        // Verify recipient matches the expected driver
                        if (
                          driver.toLowerCase() !==
                          order.driverWalletAddress.toLowerCase()
                        ) {
                          logger.error(
                            `[Verify Payouts Cron] Driver mismatch for order ${order.id}`,
                            {
                              expected: order.driverWalletAddress,
                              got: driver,
                              orderId: order.id,
                            },
                          );
                          continue;
                        }

                        // Verify tip amount matches the order
                        const expectedTip = BigInt(
                          order.tip ? Math.round(parseFloat(order.tip)) : 0,
                        );
                        if (tipAmount !== expectedTip) {
                          logger.error(
                            `[Verify Payouts Cron] Tip amount mismatch for order ${order.id}`,
                            {
                              expected: expectedTip,
                              got: tipAmount,
                              orderId: order.id,
                            },
                          );
                          continue;
                        }

                        verifiedEventFound = true;
                        break;
                      }
                    } catch (decodeError) {
                      // Log decode errors but continue checking other logs
                      logger.warn(
                        `[Verify Payouts Cron] Failed to decode log for order ${order.id}`,
                        {
                          error:
                            decodeError instanceof Error
                              ? decodeError.message
                              : String(decodeError),
                          orderId: order.id,
                        },
                      );
                    }
                  }

                  if (!verifiedEventFound) {
                    logger.error(
                      `[Verify Payouts Cron] No valid TipReleased event found for order ${order.id}, marking as failed`,
                      { orderId: order.id },
                    );

                    // Mark as failed due to event verification failure
                    await getDb()
                      .update(orders)
                      .set({ escrowStatus: "failed" })
                      .where(eq(orders.id, order.id));

                    return {
                      orderId: order.id,
                      status: "failed" as const,
                      reason: "event_verification_failed",
                    };
                  }
                }

                logger.info(
                  `[Verify Payouts Cron] Tip release confirmed on-chain: ${order.id}`,
                  { orderId: order.id },
                );

                // Mark as completed
                await getDb()
                  .update(orders)
                  .set({
                    escrowStatus: "completed",
                    payoutProcessedAt: new Date(),
                  })
                  .where(eq(orders.id, order.id));

                return { orderId: order.id, status: "completed" as const };
              } else {
                logger.error(
                  `[Verify Payouts Cron] Tip release reverted on-chain: ${order.id}`,
                  { orderId: order.id },
                );

                // Mark as failed
                await getDb()
                  .update(orders)
                  .set({ escrowStatus: "failed" })
                  .where(eq(orders.id, order.id));

                return {
                  orderId: order.id,
                  status: "failed" as const,
                  reason: "reverted",
                };
              }
            } catch (error) {
              // Transaction not found yet (still pending) - leave as released
              // It will be picked up on the next cron run
              logger.info(
                `[Verify Payouts Cron] Tip release still pending: ${order.id}`,
                {
                  orderId: order.id,
                  error:
                    error instanceof Error ? error.message : "Unknown error",
                },
              );
              return { orderId: order.id, status: "pending" as const };
            }
          },
        );

        // Wait for batch to complete before starting next batch
        const batchResults = await Promise.allSettled(batchPromises);

        // Process batch results
        for (let j = 0; j < batchResults.length; j++) {
          const result = batchResults[j];
          const order = batch[j];

          if (result.status === "fulfilled") {
            results.push(result.value);
          } else {
            // Promise rejected - log error and return pending status
            logger.error(
              `[Verify Payouts Cron] Verification promise rejected for ${order.id}`,
              {
                orderId: order.id,
                reason:
                  result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason),
              },
            );
            results.push({
              orderId: order.id,
              status: "pending" as const,
              error: "verification_failed",
            });
          }
        }

        // Small delay between batches to avoid rate limiting
        if (i + BATCH_SIZE < releasedOrders.length) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      // Count results
      const completedCount = results.filter(
        (r) => r.status === "completed",
      ).length;
      const failedCount = results.filter((r) => r.status === "failed").length;
      const pendingCount = results.filter((r) => r.status === "pending").length;

      span.setAttributes({
        "cron.completed_count": completedCount,
        "cron.failed_count": failedCount,
        "cron.pending_count": pendingCount,
      });
      span.setStatus({ code: SpanStatusCode.OK });

      const result = {
        success: true,
        message: `Verified ${completedCount + failedCount} tip releases, ${pendingCount} still pending`,
        verifiedCount: completedCount + failedCount,
        completedCount,
        failedCount,
        pendingCount,
        timestamp: new Date().toISOString(),
      };

      logger.info("[Verify Payouts Cron] Verification completed", {
        result,
        traceId,
      });

      return NextResponse.json(result);
    } catch (error) {
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      );
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      logger.error("[Verify Payouts Cron] Critical error", {
        error: error instanceof Error ? error.message : String(error),
        traceId,
      });
      throw error;
    } finally {
      span.end();
    }
  });
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
