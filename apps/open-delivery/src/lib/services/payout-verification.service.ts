import { getDb, orders, eq, and, isNotNull, drivers } from "@repo/database";
import { type Address, decodeEventLog } from "viem";
import { getPublicClient } from "@repo/web3";
import { ESCROW_ABI } from "@repo/shared/utils/escrow-abi";
import { QStashService, Logger, AppConfig } from "@repo/shared";
import { trace, Span, SpanStatusCode } from "@opentelemetry/api";
import { NextRequest, NextResponse } from "next/server";

const tracer = trace.getTracer("open-delivery-payout-verification-service");
const logger = new Logger({ serviceName: "payout-verification-service" });

const QSTASH_HOP_HEADER = "x-qstash-hop-count";
const MAX_QSTASH_HOP_COUNT = 5;
const BATCH_SIZE = 2;

// ============================================================================
// DURABLE EXECUTION PATTERN
//
// This service uses a QStash-based self-trigger pattern for serverless durability,
// which is different from the yield-and-resume pattern used in WorkflowMachine.
//
// ## Strategy Comparison:
// - WorkflowMachine: Uses yield-and-resume with Redis checkpointing (stateful)
// - PayoutVerification: Uses QStash message queue with hop-count limiting (stateless)
//
// ## Why QStash Self-Trigger?
// The payout verification is naturally batch-oriented:
// 1. Each order verification is independent (no saga compensation needed)
// 2. QStash provides reliable delivery with built-in retry
// 3. Hop-count header prevents infinite loops without external state
// 4. No checkpoint needed - progress is tracked via DB state (escrowStatus)
//
// This is more efficient than yield-and-resume for this use case because:
// - No Redis checkpoint overhead
// - Natural parallelism (batches can run concurrently)
// - Serverless timeout is handled by queueing, not state serialization
//
// @see T6: Durable Execution Formalization - Audit Roadmap
// @see packages/shared/src/services/durable-executor.ts (BaseDurableExecutor)
// ============================================================================

// ============================================================================
// TYPES
// ============================================================================

export interface PayoutVerificationResult {
  orderId: string;
  status: "completed" | "failed" | "pending";
  reason?: string;
  error?: string;
}

export interface ReleasedOrder {
  id: string;
  payoutTxHash: string | null;
  escrowStatus: string | null;
  tip: string | null;
  driverWalletAddress: string | null;
}

export interface PayoutVerificationSummary {
  success: boolean;
  message: string;
  verifiedCount: number;
  completedCount: number;
  failedCount: number;
  pendingCount: number;
  timestamp: string;
}

// ============================================================================
// PAYOUT VERIFICATION SERVICE
// ============================================================================

export class PayoutVerificationService {
  /**
   * Verify tip releases for orders with escrowStatus = 'released'.
   * Handles batch processing with QStash self-trigger for serverless timeout safety.
   */
  async processPayoutVerifications(
    req: NextRequest,
    maxOrdersPerRun: number = 15,
  ): Promise<NextResponse> {
    const traceId = req.headers.get("x-trace-id") || undefined;
    const hopCountHeader = req.headers.get(QSTASH_HOP_HEADER);
    const currentHopCount = hopCountHeader ? parseInt(hopCountHeader, 10) : 0;

    // CRITICAL: Halt if hop count exceeds threshold to prevent infinite loops
    if (currentHopCount > MAX_QSTASH_HOP_COUNT) {
      logger.error(
        `QStash self-trigger hop count exceeded (${currentHopCount}/${MAX_QSTASH_HOP_COUNT}). Halting to prevent infinite loop.`,
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

    return tracer.startActiveSpan(
      "verify-payouts-sweep",
      async (span: Span) => {
        try {
          if (traceId) {
            span.setAttribute("http.request.trace_id", traceId);
          }

          logger.info("Starting tip release verification...", {
            traceId,
            hopCount: currentHopCount,
          });

          const database = getDb();

          // Query orders with released escrow status and a tx hash
          const releasedOrders = await this.queryReleasedOrders(
            database,
            maxOrdersPerRun,
          );

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
          const hasMoreOrders = releasedOrders.length >= maxOrdersPerRun;
          if (hasMoreOrders) {
            await this.scheduleQStashSelfTrigger(req, currentHopCount);
          }

          span.setAttribute(
            "cron.released_orders_found",
            releasedOrders.length,
          );
          logger.info(`Found ${releasedOrders.length} tip releases to verify`, {
            traceId,
          });

          // Process verifications in batches
          const results = await this.processBatchVerifications(
            releasedOrders,
            traceId,
          );

          const completedCount = results.filter(
            (r) => r.status === "completed",
          ).length;
          const failedCount = results.filter(
            (r) => r.status === "failed",
          ).length;
          const pendingCount = results.filter(
            (r) => r.status === "pending",
          ).length;

          span.setAttributes({
            "cron.completed_count": completedCount,
            "cron.failed_count": failedCount,
            "cron.pending_count": pendingCount,
          });
          span.setStatus({ code: SpanStatusCode.OK });

          const summary: PayoutVerificationSummary = {
            success: true,
            message: `Verified ${completedCount + failedCount} tip releases, ${pendingCount} still pending`,
            verifiedCount: completedCount + failedCount,
            completedCount,
            failedCount,
            pendingCount,
            timestamp: new Date().toISOString(),
          };

          logger.info("Verification completed", { summary, traceId });

          return NextResponse.json(summary);
        } catch (error) {
          span.recordException(
            error instanceof Error ? error : new Error(String(error)),
          );
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          logger.error("Critical error", {
            error: error instanceof Error ? error.message : String(error),
            traceId,
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Query orders with released escrow status.
   */
  private async queryReleasedOrders(
    database: ReturnType<typeof getDb>,
    limit: number,
  ): Promise<ReleasedOrder[]> {
    return database
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
      .limit(limit);
  }

  /**
   * Schedule QStash self-trigger for remaining orders.
   */
  private async scheduleQStashSelfTrigger(
    req: NextRequest,
    currentHopCount: number,
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
        "Failed to schedule QStash self-trigger for remaining orders",
        {
          error: err instanceof Error ? err.message : String(err),
          traceId,
          hopCount: nextHopCount,
        },
      );
    });
  }

  /**
   * Process batch verifications for released orders.
   */
  private async processBatchVerifications(
    releasedOrders: ReleasedOrder[],
    traceId?: string,
  ): Promise<PayoutVerificationResult[]> {
    const publicClient = getPublicClient("base");
    const ESCROW_CONTRACT_ADDRESS = process.env
      .NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS as Address;

    const results: PayoutVerificationResult[] = [];

    for (let i = 0; i < releasedOrders.length; i += BATCH_SIZE) {
      const batch = releasedOrders.slice(i, i + BATCH_SIZE);
      logger.info(
        `Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} tip releases)`,
        { traceId },
      );

      const batchPromises = batch.map(async (order) => {
        try {
          const hash = order.payoutTxHash as `0x${string}`;

          // Get transaction receipt
          const receipt = await publicClient.getTransactionReceipt({ hash });

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
                      logger.error("Driver mismatch for order", {
                        expected: order.driverWalletAddress,
                        got: driver,
                        orderId: order.id,
                      });
                      continue;
                    }

                    // Verify tip amount matches the order
                    const expectedTip = BigInt(
                      order.tip ? Math.round(parseFloat(order.tip)) : 0,
                    );
                    if (tipAmount !== expectedTip) {
                      logger.error("Tip amount mismatch for order", {
                        expected: expectedTip,
                        got: tipAmount,
                        orderId: order.id,
                      });
                      continue;
                    }

                    verifiedEventFound = true;
                    break;
                  }
                } catch (decodeError) {
                  logger.warn("Failed to decode log for order", {
                    error:
                      decodeError instanceof Error
                        ? decodeError.message
                        : String(decodeError),
                    orderId: order.id,
                  });
                }
              }

              if (!verifiedEventFound) {
                logger.error(
                  "No valid TipReleased event found for order, marking as failed",
                  { orderId: order.id },
                );

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

            logger.info("Tip release confirmed on-chain", {
              orderId: order.id,
            });

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
            logger.error("Tip release reverted on-chain", {
              orderId: order.id,
            });

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
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          const isFatalError =
            errorMsg.includes("invalid") ||
            errorMsg.includes("not found") ||
            errorMsg.includes("unknown transaction");

          if (isFatalError) {
            logger.error("Fatal error for order, marking as failed", {
              orderId: order.id,
              error: errorMsg,
            });
            await getDb()
              .update(orders)
              .set({ escrowStatus: "failed" })
              .where(eq(orders.id, order.id));
            return {
              orderId: order.id,
              status: "failed" as const,
              reason: "fatal_verification_error",
            };
          }

          logger.info("Tip release still pending", {
            orderId: order.id,
            error: errorMsg,
          });
          return { orderId: order.id, status: "pending" as const };
        }
      });

      const batchResults = await Promise.allSettled(batchPromises);

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        const order = batch[j];

        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          logger.error("Verification promise rejected for order", {
            orderId: order.id,
            reason:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          });
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

    return results;
  }
}
