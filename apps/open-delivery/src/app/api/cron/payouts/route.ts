import { NextRequest, NextResponse } from "next/server";
import {
  getDb,
  orders,
  orderItems,
  restaurants,
  drivers,
  eq,
  sql,
  and,
  inArray,
} from "@repo/database";
import { parseEther, formatEther, type Address } from "viem";
import { base } from "viem/chains";
import { ESCROW_ABI } from "@repo/shared/utils/escrow-abi";
import { withCronAuth, Logger, withDistributedLock } from "@repo/shared";
import { withServerlessTimeout } from "@repo/shared/middleware/serverless-timeout";
import {
  getEscrowResolverWalletClient,
  getPublicClient,
  getEscrowResolverAddress,
  getDynamicGasPrice,
  nonceManager,
} from "@repo/shared/utils/wallet-provider";
import { usdToCryptoBigInt } from "@repo/shared/utils/crypto-price";

const logger = new Logger({ serviceName: "payout-cron" });

/**
 * Driver Tip Release Cron Endpoint
 *
 * NON-CUSTODIAL P2P ESCROW MODEL
 *
 * How it works:
 * - At checkout, the customer deposits funds into the escrow smart contract
 * - The escrow contract instantly routes: subtotal -> restaurant, fee -> platform
 * - The driver's tip is LOCKED in the escrow contract
 * - This cron job calls releaseTip() to unlock and send the tip to the driver
 *
 * The backend NEVER holds customer funds. It only acts as an authorized resolver
 * with permission to trigger the escrow's releaseTip() function.
 *
 * Security:
 * - Requires CRON_SECRET header for authentication
 * - Idempotent: won't process same order twice
 * - The escrow resolver key CANNOT withdraw funds, only release tips
 *
 * Usage:
 * GET /api/cron/payouts
 * Headers:
 *   Authorization: Bearer <CRON_SECRET>
 */

async function getCronHandler(req: NextRequest) {
  const db = getDb();
  const traceId = req.headers.get("x-trace-id") || undefined;
  const requestLogger = traceId ? logger.child({ traceId }) : logger;

  requestLogger.info("Starting driver tip release processing");

  try {
    // ============================================================================
    // STATE RECOVERY: Reset orphaned 'releasing' payouts back to 'locked'
    // If cron crashed mid-payout, these would be stuck forever otherwise
    // ============================================================================
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

    const orphanedPayouts = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.escrowStatus, "releasing"),
          sql`${orders.payoutProcessedAt} < ${fifteenMinutesAgo}`,
        ),
      )
      .limit(50);

    if (orphanedPayouts.length > 0) {
      logger.info("Recovering orphaned payouts stuck in releasing", {
        count: orphanedPayouts.length,
      });

      // CRITICAL FIX: Do not blindly revert to "locked". Check on-chain first
      // to avoid double-payout if the RPC timed out after broadcasting.
      const ESCROW_CONTRACT_ADDRESS = process.env
        .NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS as Address;
      const publicClient = await getPublicClient(base.id);

      const stillLocked: string[] = [];
      const alreadyReleased: string[] = [];

      for (const order of orphanedPayouts) {
        try {
          // Check for TipReleased event on-chain
          const logs = await publicClient.getLogs({
            address: ESCROW_CONTRACT_ADDRESS,
            event: {
              name: "TipReleased",
              type: "event",
              anonymous: false,
              inputs: [
                { indexed: true, name: "orderId", type: "string" },
                { indexed: true, name: "driver", type: "address" },
                { indexed: false, name: "tipAmount", type: "uint256" },
              ],
            } as const,
            args: { orderId: order.id },
            fromBlock: "earliest",
          });

          if (logs.length > 0) {
            // Tip was already released on-chain - mark as released in DB
            alreadyReleased.push(order.id);
            await getDb()
              .update(orders)
              .set({ escrowStatus: "released" })
              .where(eq(orders.id, order.id));
          } else {
            // No on-chain release - safe to revert to locked
            stillLocked.push(order.id);
          }
        } catch (chainError) {
          logger.warn("Could not check on-chain tip status for order", {
            orderId: order.id,
            error:
              chainError instanceof Error
                ? chainError.message
                : String(chainError),
          });
          // On chain check failure, conservatively revert to locked
          stillLocked.push(order.id);
        }
      }

      if (stillLocked.length > 0) {
        await getDb()
          .update(orders)
          .set({ escrowStatus: "locked", payoutProcessedAt: null })
          .where(inArray(orders.id, stillLocked));
      }

      logger.info("Successfully recovered orphaned payouts", {
        totalChecked: orphanedPayouts.length,
        revertedToLocked: stillLocked.length,
        alreadyReleasedOnChain: alreadyReleased.length,
      });
    }

    // Query all delivered orders with locked escrow (tip needs to be released)
    const deliveredOrders = await db
      .select({
        id: orders.id,
        tip: orders.tip,
        paymentCurrency: orders.paymentCurrency,
        paymentTxHash: orders.paymentTxHash,
        walletAddress: orders.walletAddress,
        storeId: orders.storeId,
        driverId: orders.driverId,
        deliveredAt: orders.deliveredAt,
        escrowStatus: orders.escrowStatus,
        restaurant: {
          id: restaurants.id,
          name: restaurants.name,
          walletAddress: restaurants.walletAddress,
        },
        driver: {
          id: drivers.id,
          fullName: drivers.fullName,
          walletAddress: drivers.walletAddress,
        },
      })
      .from(orders)
      .leftJoin(restaurants, eq(orders.storeId, restaurants.id))
      .leftJoin(drivers, eq(orders.driverId, drivers.id))
      .where(
        and(
          eq(orders.status, "delivered"),
          eq(orders.escrowStatus, "locked"), // Only process orders with locked tips
        ),
      )
      .limit(100); // Process up to 100 orders per run

    if (deliveredOrders.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No locked tips to release",
        payouts: {
          drivers: [],
        },
        processedCount: 0,
      });
    }

    // Build driver payout list
    const driverPayouts: Array<{
      address: string;
      tipAmount: string;
      currency: string;
      orderId: string;
      driverName: string;
    }> = [];

    for (const order of deliveredOrders) {
      try {
        const tip = BigInt(order.tip || "0");
        const currency = order.paymentCurrency || "USDC";

        // Skip if no payment was made
        if (!order.paymentTxHash) {
          logger.warn("Order has no payment transaction, skipping", {
            orderId: order.id,
          });
          continue;
        }

        // Skip if driver has no wallet address
        if (!order.driver?.walletAddress) {
          logger.warn("Driver has no wallet address, skipping payout", {
            orderId: order.id,
          });
          continue;
        }

        driverPayouts.push({
          address: order.driver.walletAddress,
          tipAmount: tip.toString(),
          currency,
          orderId: order.id,
          driverName: order.driver.fullName || "Unknown",
        });

        logger.info("Queued tip release", {
          orderId: order.id,
          tipAmount: tip.toString(),
          currency,
          driverAddress: order.driver.walletAddress,
        });
      } catch (error: unknown) {
        logger.error("Error processing order", {
          orderId: order.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // ============================================================================
    // EXECUTE TIP RELEASES
    // Call escrow.releaseTip() to unlock and send tips to drivers
    // ============================================================================

    let executedCount = 0;
    const startTime = Date.now();
    const VERCEL_TIMEOUT_THRESHOLD = 8000; // Exit at 8 seconds to avoid 10s hard timeout

    const MAX_RETRIES = 3;
    const BASE_DELAY = 1000; // 1 second

    async function executeWithNonceRetry<T>(fn: () => Promise<T>): Promise<T> {
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          return await fn();
        } catch (error: unknown) {
          lastError = error as Error;
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          const isRetryable =
            errorMsg.includes("nonce too low") ||
            errorMsg.includes("NONCE_TOO_LOW") ||
            errorMsg.includes("replacement transaction underpriced") ||
            errorMsg.includes("UNDERPRICED");

          if (!isRetryable) throw error;

          const delay = Math.random() * BASE_DELAY * Math.pow(2, attempt);
          logger.warn(`Payout nonce retry ${attempt + 1}/${MAX_RETRIES}`, {
            delay,
            error: errorMsg,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      throw lastError;
    }

    if (driverPayouts.length > 0) {
      try {
        // Escrow contract address
        const ESCROW_CONTRACT_ADDRESS = process.env
          .NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS as Address;
        if (!ESCROW_CONTRACT_ADDRESS) {
          throw new Error("NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS not configured");
        }

        // Get wallet client using centralized provider
        const walletClient = await getEscrowResolverWalletClient(base.id);
        const resolverAccount = walletClient.account;

        if (!resolverAccount) {
          logger.error(
            "CRITICAL: No resolver account configured, aborting tip releases",
          );
          return NextResponse.json(
            { success: false, error: "No resolver account configured" },
            { status: 500 },
          );
        }

        // ============================================================================
        // GAS MONITORING: Check resolver wallet has sufficient gas before executing
        // Prevents silent failures from depleted resolver wallet
        // Dynamically calculate minimum balance based on current ETH price ($15 USD equivalent)
        // ============================================================================

        const publicClient = await getPublicClient(base.id);

        try {
          // Calculate $15.00 USD in ETH (as wei)
          const minBalanceWei = await usdToCryptoBigInt(
            BigInt(1500) as bigint,
            "ETH",
          );
          const minBalanceEth = parseFloat(formatEther(minBalanceWei));

          const resolverBalance = await publicClient.getBalance({
            address: resolverAccount.address,
          });
          const balanceInEth =
            Number(resolverBalance) / Number(parseEther("1"));

          logger.info("Resolver wallet balance check", {
            address: resolverAccount.address,
            balanceEth: balanceInEth,
            minBalanceEth: minBalanceEth,
          });

          if (balanceInEth < minBalanceEth) {
            logger.error(
              "CRITICAL: Resolver wallet balance below minimum, aborting tip releases",
              {
                address: resolverAccount.address,
                currentBalance: balanceInEth,
                minimumBalance: minBalanceEth,
                pendingPayouts: driverPayouts.length,
              },
            );

            // Send monitoring alert if MonitoringService is available
            try {
              const { MonitoringService, AlertLevel } =
                await import("@repo/shared/services/monitoring");
              await MonitoringService.sendAlert(
                `Escrow resolver wallet low on gas`,
                AlertLevel.CRITICAL,
                {
                  address: resolverAccount.address,
                  currentBalance: `${balanceInEth.toFixed(6)} ETH`,
                  minimumBalance: `${minBalanceEth.toFixed(6)} ETH`,
                  pendingPayouts: driverPayouts.length,
                  action:
                    "Fund resolver wallet immediately to resume tip releases",
                },
              );
            } catch (alertError: unknown) {
              logger.error("Failed to send monitoring alert", {
                error:
                  alertError instanceof Error
                    ? alertError.message
                    : String(alertError),
              });
            }

            return NextResponse.json(
              {
                success: false,
                error: "Resolver wallet insufficient gas",
                message: `Resolver wallet has ${balanceInEth.toFixed(6)} ETH (minimum: ${minBalanceEth.toFixed(6)} ETH). Fund wallet before retrying.`,
                resolverAddress: resolverAccount.address,
                currentBalance: `${balanceInEth.toFixed(6)} ETH`,
                minimumBalance: `${minBalanceEth.toFixed(6)} ETH`,
                pendingPayouts: driverPayouts.length,
                timestamp: new Date().toISOString(),
              },
              { status: 503 },
            );
          }
        } catch (balanceError: unknown) {
          logger.error("Failed to check resolver wallet balance", {
            error:
              balanceError instanceof Error
                ? balanceError.message
                : String(balanceError),
          });
          // Don't abort - proceed with caution, the balance check is best-effort
        }

        logger.info("Releasing tips via escrow", {
          tipCount: driverPayouts.length,
          resolverAddress: resolverAccount.address,
        });

        /**
         * Execute a single tip release with timeout protection
         */
        const executeTipRelease = async (payout: {
          address: string;
          tipAmount: string;
          currency: string;
          orderId: string;
        }): Promise<boolean> => {
          // Check if we're approaching Vercel timeout
          const timeElapsed = Date.now() - startTime;
          const timeRemaining = VERCEL_TIMEOUT_THRESHOLD - timeElapsed;

          if (timeRemaining <= 0) return false;

          return executeWithNonceRetry(async () => {
            // Mark as releasing first (idempotency)
            await getDb()
              .update(orders)
              .set({ escrowStatus: "releasing" })
              .where(eq(orders.id, payout.orderId));

            const nonce = await nonceManager.getNextNonce(
              base.id,
              resolverAccount.address,
              publicClient,
            );
            const { gasPrice } = await getDynamicGasPrice(publicClient);

            // Call escrow.releaseTip(orderId, driver) with timeout protection
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("RPC_TIMEOUT")), timeRemaining),
            );

            const hash = await Promise.race([
              walletClient.writeContract({
                address: ESCROW_CONTRACT_ADDRESS,
                abi: ESCROW_ABI,
                functionName: "releaseTip",
                args: [payout.orderId, payout.address as Address],
                account: resolverAccount,
                chain: base,
                nonce,
                gasPrice,
              }),
              timeoutPromise,
            ]);

            logger.info("Tip release submitted", {
              orderId: payout.orderId,
              driverAddress: payout.address,
              tipAmount: payout.tipAmount,
              currency: payout.currency,
              txHash: hash,
              nonce,
              gasPrice: gasPrice.toString(),
            });

            // Save the tx hash and mark as released
            await getDb()
              .update(orders)
              .set({
                escrowStatus: "released",
                payoutTxHash: hash,
                payoutProcessedAt: new Date(),
              })
              .where(eq(orders.id, payout.orderId));

            return true;
          }).catch(async (error: unknown) => {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            if (errorMsg === "RPC_TIMEOUT") {
              logger.warn(
                "RPC call timed out, checking on-chain status before marking failed",
                { orderId: payout.orderId },
              );

              // CRITICAL FIX: On RPC timeout, check on-chain for TipReleased event
              // before marking as failed. If the tx was actually broadcast, we don't
              // want to mark it as failed and risk a duplicate payout on next run.
              try {
                const logs = await publicClient.getLogs({
                  address: ESCROW_CONTRACT_ADDRESS,
                  event: {
                    name: "TipReleased",
                    type: "event",
                    anonymous: false,
                    inputs: [
                      { indexed: false, name: "orderId", type: "string" },
                      { indexed: true, name: "driver", type: "address" },
                      { indexed: false, name: "tipAmount", type: "uint256" },
                    ],
                  } as const,
                  args: { driver: payout.address as `0x${string}` },
                  fromBlock: "earliest",
                });

                if (logs.length > 0) {
                  // Transaction succeeded on-chain despite RPC timeout
                  logger.info(
                    "On-chain check shows tip was released despite RPC timeout",
                    { orderId: payout.orderId },
                  );
                  await getDb()
                    .update(orders)
                    .set({ escrowStatus: "released" })
                    .where(eq(orders.id, payout.orderId));
                  return true;
                }
              } catch (chainCheckError) {
                logger.warn(
                  "On-chain tip status check failed after RPC timeout",
                  {
                    orderId: payout.orderId,
                    error:
                      chainCheckError instanceof Error
                        ? chainCheckError.message
                        : String(chainCheckError),
                  },
                );
              }

              // No on-chain release found - mark as failed (safe to retry next run)
              await getDb()
                .update(orders)
                .set({ escrowStatus: "failed" })
                .where(eq(orders.id, payout.orderId));
            } else {
              logger.error("Failed to release tip", {
                orderId: payout.orderId,
                error: errorMsg,
              });
              // Mark as failed
              await getDb()
                .update(orders)
                .set({ escrowStatus: "failed" })
                .where(eq(orders.id, payout.orderId));
            }
            return false;
          });
        };

        // Process in batches of 5 to avoid overwhelming the RPC and manage timeout risk
        const BATCH_SIZE = 5;
        const batches = [];
        for (let i = 0; i < driverPayouts.length; i += BATCH_SIZE) {
          batches.push(driverPayouts.slice(i, i + BATCH_SIZE));
        }

        logger.info("Processing tip releases in batches", {
          totalTips: driverPayouts.length,
          batchCount: batches.length,
          batchSize: BATCH_SIZE,
        });

        // Execute batches sequentially, but payouts within each batch in parallel
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
          const batch = batches[batchIndex];

          // Check timeout before starting batch
          if (Date.now() - startTime > VERCEL_TIMEOUT_THRESHOLD) {
            logger.warn(
              "Approaching Vercel timeout before batch, stopping execution",
              { batchIndex: batchIndex + 1 },
            );
            break;
          }

          logger.info("Executing batch", {
            batchIndex: batchIndex + 1,
            totalBatches: batches.length,
            tipCount: batch.length,
          });

          // Execute batch in parallel with Promise.allSettled
          const results = await Promise.allSettled(
            batch.map((payout) => executeTipRelease(payout)),
          );

          // Count successful executions
          const batchSuccesses = results.filter(
            (r) => r.status === "fulfilled" && r.value === true,
          ).length;

          executedCount += batchSuccesses;

          logger.info("Batch completed", {
            batchIndex: batchIndex + 1,
            successes: batchSuccesses,
            total: batch.length,
          });
        }

        logger.info("Successfully released tips", { executedCount });
      } catch (error: unknown) {
        logger.error("Critical error during tip release execution", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const result = {
      success: true,
      message: `Processed ${driverPayouts.length} tip releases, executed ${executedCount}`,
      payouts: {
        drivers: driverPayouts,
      },
      processedCount: driverPayouts.length,
      executedCount,
      timestamp: new Date().toISOString(),
    };

    logger.info("Payout cron completed successfully", {
      processedCount: driverPayouts.length,
      executedCount,
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    logger.error("Critical error in payout cron", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

/**
 * POST endpoint to manually trigger payout processing
 * Useful for testing or manual intervention
 */
async function postCronHandler(req: NextRequest) {
  return getCronHandler(req);
}

// Wrap handlers with cron authentication, distributed lock, and serverless timeout
export const GET = withServerlessTimeout(
  withCronAuth(async (req: NextRequest) => {
    const lockKey = "cron:open-delivery:payouts";
    const lockTtlSeconds = 120; // 2 minutes for payout processing

    try {
      return await withDistributedLock(lockKey, lockTtlSeconds, async () =>
        getCronHandler(req),
      );
    } catch (error) {
      // If lock acquisition fails, return 200 OK to indicate graceful skip
      if (
        error instanceof Error &&
        error.message.includes("Failed to acquire distributed lock")
      ) {
        logger.info("Payout cron skipped - another instance is running");
        return NextResponse.json({
          success: true,
          skipped: true,
          message: "Another instance is running",
        });
      }
      throw error;
    }
  }),
  8000,
) as any;

export const POST = withServerlessTimeout(
  withCronAuth(async (req: NextRequest) => {
    const lockKey = "cron:open-delivery:payouts";
    const lockTtlSeconds = 120; // 2 minutes for payout processing

    try {
      return await withDistributedLock(lockKey, lockTtlSeconds, async () =>
        postCronHandler(req),
      );
    } catch (error) {
      // If lock acquisition fails, return 200 OK to indicate graceful skip
      if (
        error instanceof Error &&
        error.message.includes("Failed to acquire distributed lock")
      ) {
        logger.info("Payout cron skipped - another instance is running");
        return NextResponse.json({
          success: true,
          skipped: true,
          message: "Another instance is running",
        });
      }
      throw error;
    }
  }),
  8000,
) as any;
