import { NextRequest, NextResponse } from 'next/server';
import { db, orders, orderItems, restaurants, drivers, eq, sql, and } from "@repo/database";
import { createWalletClient, createPublicClient, http, parseAbi, parseUnits, type Address } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ERC20_ABI } from '@repo/shared/utils/erc20-abi';

/**
 * Payout Ledger Cron Endpoint
 *
 * SECURE PAYOUT DISTRIBUTION FOR OPEN-DELIVERY
 *
 * Problem Solved:
 * - Previously, tips were sent directly to restaurant wallets (tip theft)
 * - Now all payments go to treasury, and this cron generates payout instructions
 *
 * What it does:
 * 1. Queries all delivered orders with pending payout status
 * 2. Calculates split: restaurant (subtotal), driver (tip + base pay), platform (fee)
 * 3. EXECUTES batch payment execution via treasury wallet
 * 4. Marks orders as "completed" to prevent duplicate payouts
 *
 * Security:
 * - Requires CRON_SECRET header for authentication
 * - Idempotent: won't process same order twice
 * - Audit trail: logs all payout calculations
 *
 * Usage:
 * GET /api/cron/payouts
 * Headers:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Response:
 * {
 *   success: true,
 *   payouts: {
 *     restaurants: [{ address: string, amount: string, orderId: string }],
 *     drivers: [{ address: string, amount: string, orderId: string }],
 *     platform: { totalFees: string }
 *   },
 *   processedCount: number,
 *   executedCount: number
 * }
 */

const CRON_SECRET = process.env.CRON_SECRET;

// Platform fee percentage (in basis points, 100 = 1%)
const PLATFORM_FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || "100", 10);

// Base pay for drivers per delivery (in USDC cents)
const DRIVER_BASE_PAY = parseInt(process.env.DRIVER_BASE_PAY_CENTS || "200", 10);

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
    if (!CRON_SECRET || providedSecret !== CRON_SECRET) {
      console.warn('[Payout Cron] Invalid cron secret provided');
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    console.log('[Payout Cron] Starting payout processing...');

    // ============================================================================
    // STATE RECOVERY: Reset orphaned 'processing' payouts back to 'pending'
    // If cron crashed mid-payout, these would be stuck forever otherwise
    // ============================================================================
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    
    const orphanedPayouts = await db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.payoutStatus, 'processing'),
          sql`${orders.payoutProcessedAt} < ${fifteenMinutesAgo}`
        )
      )
      .limit(50);

    if (orphanedPayouts.length > 0) {
      console.log(`[Payout Cron] Recovering ${orphanedPayouts.length} orphaned payouts stuck in 'processing'`);
      
      for (const order of orphanedPayouts) {
        await db.update(orders)
          .set({ payoutStatus: 'pending', payoutProcessedAt: null })
          .where(eq(orders.id, order.id));
      }
      
      console.log(`[Payout Cron] Successfully recovered ${orphanedPayouts.length} orphaned payouts`);
    }

    // Query all delivered orders with pending payout status
    const deliveredOrders = await db
      .select({
        id: orders.id,
        subtotal: orders.subtotal,
        tip: orders.tip,
        total: orders.total,
        paymentCurrency: orders.paymentCurrency,
        paymentTxHash: orders.paymentTxHash,
        walletAddress: orders.walletAddress,
        storeId: orders.storeId,
        driverId: orders.driverId,
        deliveredAt: orders.deliveredAt,
        payoutStatus: orders.payoutStatus,
        restaurant: {
          id: restaurants.id,
          name: restaurants.name,
          walletAddress: restaurants.walletAddress,
          ownerEmail: restaurants.ownerEmail,
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
          eq(orders.status, 'delivered'),
          eq(orders.payoutStatus, 'pending'), // Only process pending payouts
        )
      )
      .limit(100); // Process up to 100 orders per run

    if (deliveredOrders.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No pending payouts to process',
        payouts: {
          restaurants: [],
          drivers: [],
          platform: { totalFees: '0' },
        },
        processedCount: 0,
      });
    }

    // Calculate payouts
    const restaurantPayouts: Array<{
      address: string;
      amount: string;
      currency: string;
      orderId: string;
      restaurantName: string;
    }> = [];

    const driverPayouts: Array<{
      address: string;
      amount: string;
      currency: string;
      orderId: string;
      driverName: string;
      breakdown: {
        tip: string;
        basePay: string;
      };
    }> = [];

    let totalPlatformFees = BigInt(0);

    for (const order of deliveredOrders) {
      try {
        const subtotal = BigInt(order.subtotal || '0');
        const tip = BigInt(order.tip || '0');
        const total = BigInt(order.total || '0');
        const currency = order.paymentCurrency || 'USDC';

        // Skip if no payment was made
        if (!order.paymentTxHash) {
          console.warn(`[Payout Cron] Order ${order.id} has no payment transaction, skipping`);
          continue;
        }

        // Skip if restaurant has no wallet address
        if (!order.restaurant?.walletAddress) {
          console.warn(`[Payout Cron] Restaurant ${order.restaurant?.name} has no wallet address, skipping payout for order ${order.id}`);
          continue;
        }

        // Skip if driver has no wallet address
        if (!order.driver?.walletAddress) {
          console.warn(`[Payout Cron] Driver has no wallet address, skipping payout for order ${order.id}`);
          continue;
        }

        // Calculate platform fee (1% of subtotal)
        const platformFee = (subtotal * BigInt(PLATFORM_FEE_BPS)) / BigInt(10000);
        totalPlatformFees += platformFee;

        // Restaurant receives subtotal minus platform fee
        const restaurantAmount = subtotal - platformFee;

        // Driver receives tip + base pay
        const basePayCents = BigInt(DRIVER_BASE_PAY);
        // Convert base pay to same units as tip (USDC cents = 6 decimals)
        const basePay = currency === 'USDC' ? basePayCents * BigInt(10000) : basePayCents; // Adjust for token decimals
        const driverAmount = tip + basePay;

        // Add to payout lists
        restaurantPayouts.push({
          address: order.restaurant.walletAddress,
          amount: restaurantAmount.toString(),
          currency,
          orderId: order.id,
          restaurantName: order.restaurant.name || 'Unknown',
        });

        driverPayouts.push({
          address: order.driver.walletAddress,
          amount: driverAmount.toString(),
          currency,
          orderId: order.id,
          driverName: order.driver.fullName || 'Unknown',
          breakdown: {
            tip: tip.toString(),
            basePay: basePay.toString(),
          },
        });

        console.log(`[Payout Cron] Calculated payouts for order ${order.id}:`, {
          restaurant: { amount: restaurantAmount.toString(), address: order.restaurant.walletAddress },
          driver: { amount: driverAmount.toString(), address: order.driver.walletAddress },
          platformFee: platformFee.toString(),
        });
      } catch (error) {
        console.error(`[Payout Cron] Error processing order ${order.id}:`, error);
        // Continue processing other orders
      }
    }

    // ============================================================================
    // EXECUTE PAYOUTS
    // Actually send the crypto payments to restaurants and drivers
    // ============================================================================
    
    let executedCount = 0;
    const treasuryPrivateKey = process.env.TREASURY_PRIVATE_KEY;
    
    if (treasuryPrivateKey && restaurantPayouts.length + driverPayouts.length > 0) {
      try {
        // Create wallet client from private key
        const account = privateKeyToAccount(treasuryPrivateKey as `0x${string}`);

        const walletClient = createWalletClient({
          account,
          chain: base,
          transport: http(),
        });

        // Create public client for waiting for transaction receipts
        const publicClient = createPublicClient({
          chain: base,
          transport: http(),
        });

        console.log(`[Payout Cron] Executing ${restaurantPayouts.length + driverPayouts.length} payouts from ${account.address}`);

        // USDC contract address on Base
        const USDC_CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') as Address;

        // Execute restaurant payouts
        for (const payout of restaurantPayouts) {
          try {
            // Mark as processing first (idempotency)
            await db.update(orders)
              .set({ payoutStatus: 'processing' })
              .where(eq(orders.id, payout.orderId));

            // Execute USDC transfer
            const hash = await walletClient.writeContract({
              address: USDC_CONTRACT_ADDRESS,
              abi: ERC20_ABI,
              functionName: 'transfer',
              args: [payout.address as Address, BigInt(payout.amount)],
            });

            console.log(`[Payout Cron] Restaurant payout submitted: ${payout.orderId} -> ${payout.address} (${payout.amount} ${payout.currency}) tx: ${hash}`);

            // CRITICAL FIX: Wait for transaction receipt to confirm on-chain success
            // A hash only means the tx was submitted, NOT that it succeeded
            const receipt = await publicClient.waitForTransactionReceipt({ hash });

            if (receipt.status === 'success') {
              console.log(`[Payout Cron] Restaurant payout confirmed on-chain: ${payout.orderId}`);
              
              // Only mark as completed if transaction actually succeeded
              await db.update(orders)
                .set({
                  payoutStatus: 'completed',
                  payoutProcessedAt: new Date(),
                })
                .where(eq(orders.id, payout.orderId));

              executedCount++;
            } else {
              console.error(`[Payout Cron] Restaurant payout reverted on-chain: ${payout.orderId}`);
              
              // Mark as failed if transaction reverted
              await db.update(orders)
                .set({ payoutStatus: 'failed' })
                .where(eq(orders.id, payout.orderId));
            }
          } catch (error) {
            console.error(`[Payout Cron] Failed to execute restaurant payout ${payout.orderId}:`, error);
            // Mark as failed
            await db.update(orders)
              .set({ payoutStatus: 'failed' })
              .where(eq(orders.id, payout.orderId));
          }
        }

        // Execute driver payouts
        for (const payout of driverPayouts) {
          try {
            // Mark as processing first (idempotency)
            await db.update(orders)
              .set({ payoutStatus: 'processing' })
              .where(eq(orders.id, payout.orderId));

            // Execute USDC transfer
            const hash = await walletClient.writeContract({
              address: USDC_CONTRACT_ADDRESS,
              abi: ERC20_ABI,
              functionName: 'transfer',
              args: [payout.address as Address, BigInt(payout.amount)],
            });

            console.log(`[Payout Cron] Driver payout submitted: ${payout.orderId} -> ${payout.address} (${payout.amount} ${payout.currency}) tx: ${hash}`);

            // CRITICAL FIX: Wait for transaction receipt to confirm on-chain success
            const receipt = await publicClient.waitForTransactionReceipt({ hash });

            if (receipt.status === 'success') {
              console.log(`[Payout Cron] Driver payout confirmed on-chain: ${payout.orderId}`);
              
              // Only mark as completed if transaction actually succeeded
              await db.update(orders)
                .set({
                  payoutStatus: 'completed',
                  payoutProcessedAt: new Date(),
                })
                .where(eq(orders.id, payout.orderId));

              executedCount++;
            } else {
              console.error(`[Payout Cron] Driver payout reverted on-chain: ${payout.orderId}`);
              
              // Mark as failed if transaction reverted
              await db.update(orders)
                .set({ payoutStatus: 'failed' })
                .where(eq(orders.id, payout.orderId));
            }
          } catch (error) {
            console.error(`[Payout Cron] Failed to execute driver payout ${payout.orderId}:`, error);
            // Mark as failed
            await db.update(orders)
              .set({ payoutStatus: 'failed' })
              .where(eq(orders.id, payout.orderId));
          }
        }
        
        console.log(`[Payout Cron] Successfully executed ${executedCount} payouts`);
      } catch (error) {
        console.error('[Payout Cron] Critical error during payout execution:', error);
      }
    } else if (!treasuryPrivateKey) {
      console.warn('[Payout Cron] TREASURY_PRIVATE_KEY not set - payouts calculated but NOT executed');
      console.warn('[Payout Cron] Set TREASURY_PRIVATE_KEY in environment to enable automatic payouts');
    }

    const result = {
      success: true,
      message: `Processed ${restaurantPayouts.length + driverPayouts.length} payouts, executed ${executedCount}`,
      payouts: {
        restaurants: restaurantPayouts,
        drivers: driverPayouts,
        platform: {
          totalFees: totalPlatformFees.toString(),
          feeBps: PLATFORM_FEE_BPS,
        },
      },
      processedCount: restaurantPayouts.length + driverPayouts.length,
      executedCount,
      timestamp: new Date().toISOString(),
      // Metadata for batch payment execution
      batchMetadata: {
        totalRestaurantPayouts: restaurantPayouts.length,
        totalDriverPayouts: driverPayouts.length,
        estimatedGasCost: '0', // Calculate based on current gas prices
        recommendedExecutionTime: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
      },
    };

    console.log('[Payout Cron] Completed successfully:', result);

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Payout Cron] Critical error:', error);
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
 * POST endpoint to manually trigger payout processing
 * Useful for testing or manual intervention
 */
export async function POST(req: NextRequest) {
  // Same authentication as GET
  return GET(req);
}
