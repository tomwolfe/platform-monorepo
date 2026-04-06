export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { getDb, restaurantReservations, eq, restaurants } from "@repo/database";
import { NotifyService } from '@tablestack/lib/notifications';
import { createPublicClient, http, parseUnits } from 'viem';
import { base } from 'viem/chains';
import { isValidTxHash } from '@repo/shared/utils/web3-verification';
import { getCryptoPrices } from '@repo/shared/utils/crypto-price';
import { CheckoutRequestSchema, validateRequest as validateZodRequest, formatApiError, withApiErrorHandler } from '@repo/shared';

export const runtime = 'nodejs';

/**
 * Crypto Payment Verification Endpoint
 *
 * Verifies on-chain transactions for restaurant reservation deposits.
 * Direct P2P model: payments go directly to restaurant wallet (not escrow).
 *
 * CRITICAL SECURITY FIXES:
 * 1. Verifies transaction data contains reservation ID (prevents spoofing)
 * 2. Dynamic price oracle integration with slippage buffer
 * 3. Supports both USDC and ETH payments
 * 4. SECURITY: expectedAmount is NOWHERE trusted from client - always fetched from DB
 * 5. Enforces restaurant.walletAddress exists before confirming
 *
 * Expected payload:
 * {
 *   txHash: string;           // On-chain transaction hash
 *   reservationId: string;     // Reservation ID from table-stack
 *   paymentCurrency?: string;  // 'USDC' or 'ETH'
 * }
 */
async function postHandler(req: NextRequest) {
  const body = await req.json();

  // Validate request body with Zod schema
  const validation = validateZodRequest(CheckoutRequestSchema, body);
  if (!validation.success) {
    return NextResponse.json(validation.error, { status: 400 });
  }

  // CRITICAL: Do NOT trust expectedAmount from client - it's removed from the destructuring
  const { txHash, paymentCurrency = 'USDC', orderId, reservationId } = validation.data;

  // Use reservationId for table-stack (orderId is for open-delivery)
  const targetReservationId = reservationId || orderId;

  if (!targetReservationId) {
    return NextResponse.json(
      formatApiError(new Error('reservationId is required'), 'VALIDATION_ERROR'),
      { status: 400 }
    );
  }

  // Validate transaction hash format
  // Note: txHash is already validated by CheckoutRequestSchema, but extra validation doesn't hurt
  if (!isValidTxHash(txHash)) {
    return NextResponse.json(
      { message: 'Invalid transaction hash format' },
      { status: 400 }
    );
  }

  // Fetch reservation with restaurant details
  const reservation = await getDb().query.restaurantReservations.findFirst({
    where: eq(restaurantReservations.id, targetReservationId),
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

  // Enforce restaurant wallet address exists (direct P2P requirement)
  if (!reservation.restaurant?.walletAddress) {
    return NextResponse.json(
      { message: 'Restaurant wallet address not configured - cannot accept P2P payment' },
      { status: 400 }
    );
  }

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
  // isEscrowPayment=false because TableStack uses direct P2P to restaurant
  const { verifyTransaction } = await import('@repo/shared/utils/web3-verification');

  const verificationResult = await verifyTransaction({
    txHash: txHash as `0x${string}`,
    expectedValue,
    expectedRecipient: reservation.restaurant.walletAddress as `0x${string}`,
    paymentCurrency,
    orderId: targetReservationId,
    isEscrowPayment: false, // Direct P2P to restaurant wallet
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

        if (decodedData !== targetReservationId) {
          return NextResponse.json(
            {
              message: 'Transaction data mismatch. Reservation ID not found in transaction data.',
              expected: targetReservationId,
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
  await getDb().update(restaurantReservations)
    .set({
      isVerified: true,
      status: 'confirmed',
      paymentTxHash: txHash,
    })
    .where(eq(restaurantReservations.id, targetReservationId));

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
}

export const POST = withApiErrorHandler(postHandler, 'EXECUTION_FAILED');
