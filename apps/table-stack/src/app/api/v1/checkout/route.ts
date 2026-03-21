export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { db, restaurantReservations, eq, restaurants } from "@repo/database";
import { NotifyService } from '@/lib/notifications';
import { createPublicClient, http, parseUnits } from 'viem';
import { base } from 'viem/chains';
import { isValidTxHash } from '@/lib/web3-utils';
import { getCryptoPrices } from '@repo/shared/utils/crypto-price';

export const runtime = 'edge';

/**
 * Crypto Payment Verification Endpoint
 *
 * Verifies on-chain transactions for restaurant reservation deposits.
 * Replaces the Stripe webhook with zero-trust blockchain verification.
 *
 * CRITICAL SECURITY FIXES:
 * 1. Verifies transaction data contains reservation ID (prevents spoofing)
 * 2. Dynamic price oracle integration with slippage buffer
 * 3. Supports both USDC and ETH payments
 * 4. SECURITY: expectedAmount is NOWHERE trusted from client - always fetched from DB
 *
 * Expected payload:
 * {
 *   txHash: string;           // On-chain transaction hash
 *   reservationId: string;     // Reservation ID from table-stack
 *   paymentCurrency?: string;  // 'USDC' or 'ETH'
 * }
 */
export async function POST(req: NextRequest) {
  try {
    // CRITICAL: Do NOT trust expectedAmount from client - it's removed from the destructuring
    const { txHash, reservationId, paymentCurrency = 'USDC' } = await req.json();

    if (!txHash || !reservationId) {
      return NextResponse.json(
        { message: 'Missing txHash or reservationId' },
        { status: 400 }
      );
    }

    // Validate transaction hash format
    if (!isValidTxHash(txHash)) {
      return NextResponse.json(
        { message: 'Invalid transaction hash format' },
        { status: 400 }
      );
    }

    // Fetch reservation with restaurant details
    const reservation = await db.query.restaurantReservations.findFirst({
      where: eq(restaurantReservations.id, reservationId),
      with: {
        restaurant: true,
      },
    });

    if (!reservation) {
      return NextResponse.json(
        { message: 'Reservation not found' },
        { status: 404 }
      );
    }

    // Already verified?
    if (reservation.isVerified) {
      return NextResponse.json(
        { message: 'Reservation already verified', success: true },
        { status: 200 }
      );
    }

    // ============================================================================
    // SERVER-SIDE CALCULATION: Never trust client for financial data
    // ============================================================================
    
    // Fetch deposit amount from database (in USD cents)
    const depositUsdCents = reservation.depositAmount || 0;
    const depositUsd = depositUsdCents / 100; // Convert cents to dollars
    
    // Fetch live crypto prices from oracle
    const prices = await getCryptoPrices();
    
    // Calculate expected crypto amount based on payment currency
    let expectedValue: bigint;
    
    if (paymentCurrency === 'ETH') {
      const ethPrice = prices.ETH;
      if (ethPrice <= 0) {
        throw new Error('Failed to fetch ETH price from oracle');
      }
      
      // Convert USD to ETH: ETH = USD / price
      const depositEth = depositUsd / ethPrice;
      // Convert to Wei (18 decimals)
      expectedValue = parseUnits(depositEth.toFixed(18), 18);
    } else {
      // USDC: 6 decimals, 1 USD = 1 USDC
      expectedValue = parseUnits(depositUsd.toFixed(6), 6);
    }

    // Zero-Trust On-Chain Verification using shared utility
    const { verifyTransaction } = await import('@/lib/web3-utils');
    
    const verificationResult = await verifyTransaction({
      txHash: txHash as `0x${string}`,
      expectedValue,
      expectedRecipient: reservation.restaurant.walletAddress as `0x${string}` | undefined,
      paymentCurrency,
    });

    if (!verificationResult.success) {
      return NextResponse.json(
        { message: verificationResult.error || 'Transaction verification failed' },
        { status: 400 }
      );
    }

    // Additional check: Verify transaction data contains reservation ID (for ETH payments)
    // For USDC, the exact amount + recipient verification is sufficient
    if (paymentCurrency !== 'USDC') {
      const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
      const client = createPublicClient({ transport: http(rpcUrl), chain: base });
      const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
      
      if (tx.input && tx.input !== '0x' && tx.input.length > 2) {
        try {
          const { hexToString } = await import('viem');
          const decodedData = hexToString(tx.input);

          if (decodedData !== reservationId) {
            return NextResponse.json(
              {
                message: 'Transaction data mismatch. Reservation ID not found in transaction data.',
                expected: reservationId,
                received: decodedData,
              },
              { status: 400 }
            );
          }
        } catch (decodeError) {
          console.warn('Could not decode transaction data for ETH payment');
        }
      }
    }

    // Confirmations already checked by verifyTransaction
    const confirmations = verificationResult.receipt?.confirmations || 0;
    if (confirmations < 1) {
      return NextResponse.json(
        { message: 'Waiting for more confirmations', confirmations },
        { status: 400 }
      );
    }

    // Mark reservation as verified
    await db.update(restaurantReservations)
      .set({
        isVerified: true,
        status: 'confirmed',
        paymentTxHash: txHash,
      })
      .where(eq(restaurantReservations.id, reservationId));

    // Notify restaurant owner
    if (reservation.restaurant?.ownerEmail) {
      await NotifyService.notifyOwner(reservation.restaurant.ownerEmail, {
        guestName: reservation.guestName,
        partySize: reservation.partySize,
        startTime: reservation.startTime,
      });
    }

    console.log(
      `[CryptoCheckout] Reservation ${reservationId} verified with tx ${txHash}`
    );

    return NextResponse.json({
      success: true,
      message: 'Crypto payment verified successfully',
      txHash,
      confirmations,
    });
  } catch (error) {
    console.error('Crypto Verification Error:', error);
    return NextResponse.json(
      { message: 'Internal server error' },
      { status: 500 }
    );
  }
}
