/**
 * Checkout Service
 *
 * Orchestrates the checkout flow using extracted modules.
 * This file now delegates to focused modules for validation,
 * web3 verification, reservation updates, and notifications.
 *
 * @see Task 5: Refactor Monolithic Service Files
 * @see ./checkout/ - Extracted modules
 */

import { getDb, restaurantReservations, eq } from "@repo/database";
import { errorResponse, successResponse, Logger } from "@repo/shared";
import {
  isReplayAllowed,
  tryAcquireReplayProcessingLock,
} from "@repo/shared/middleware/web3-replay-guard";
import type { CheckoutRequest, CheckoutResponse } from "@repo/shared";

// Extracted modules
import {
  CheckoutError,
  validateDeadline,
  validateChainId,
  validatePaymentMode,
  verifySignature,
  calculateExpectedCryptoAmount,
} from "./checkout/validation";
import {
  verifyOnChainTransaction,
  validateTransactionHash,
} from "./checkout/web3-verify";
import { markReservationAsVerified } from "./checkout/reservation-update";
import { notifyOwnerOfVerification } from "./checkout/notifications";

const logger = new Logger({ serviceName: "checkout-service" });

// ============================================================================
// SERVICE
// ============================================================================

export async function processCheckout(
  data: CheckoutRequest & { frontendCallbackUrl?: string },
): Promise<{ body: CheckoutResponse; status: number }> {
  const {
    txHash,
    paymentCurrency = "USDC",
    orderId,
    reservationId,
    signature,
    walletAddress,
    chainId,
    deadline,
    signedAmount,
    frontendCallbackUrl,
  } = data;

  const targetReservationId = reservationId || orderId;

  if (!targetReservationId) {
    throw new CheckoutError(
      "reservationId is required",
      400,
      "VALIDATION_ERROR",
    );
  }

  // Fetch reservation
  const reservation = await getDb().query.restaurantReservations.findFirst({
    where: eq(restaurantReservations.id, targetReservationId),
    with: { restaurant: true },
  });

  if (!reservation) {
    throw new CheckoutError("Reservation not found", 404, "NOT_FOUND");
  }

  // Validate inputs
  validateDeadline(deadline);
  validateChainId(chainId);

  // Verify EIP-712 signature
  await verifySignature({
    signature,
    walletAddress,
    targetReservationId,
    reservation,
    paymentCurrency,
    signedAmount,
    deadline,
  });

  // Validate transaction hash
  validateTransactionHash(txHash);

  // Already verified?
  if (reservation.isVerified) {
    return {
      body: successResponse(
        { isVerified: true },
        { message: "Reservation already verified" },
      ) as CheckoutResponse,
      status: 200,
    };
  }

  // Validate payment mode configuration
  validatePaymentMode(reservation);

  // Calculate expected crypto amount
  const depositUsdCents = reservation.depositAmount || 0;
  const expectedValue = await calculateExpectedCryptoAmount(
    depositUsdCents,
    paymentCurrency,
  );

  // Replay guard - acquire processing lock
  const processingLockAcquired = await tryAcquireReplayProcessingLock(
    txHash as `0x${string}`,
  );

  if (!processingLockAcquired) {
    throw new CheckoutError(
      "Payment transaction is currently being processed by another request.",
      409,
      "CONFLICT",
    );
  }

  // Replay guard - check if already used
  const replayCheck = await isReplayAllowed({
    txHash: txHash as `0x${string}`,
    appSource: "table-stack",
    entityId: targetReservationId,
  });

  if (!replayCheck) {
    throw new CheckoutError(
      "Payment transaction already used or blocked.",
      409,
      "CONFLICT",
    );
  }

  // Verify on-chain transaction
  const verificationResult = await verifyOnChainTransaction({
    txHash,
    expectedValue,
    reservation,
    paymentCurrency,
    targetReservationId,
  });

  // Verify confirmations
  const confirmations = verificationResult.receipt?.confirmations || 0;
  if (confirmations < 1) {
    throw new CheckoutError(
      "Waiting for more confirmations",
      400,
      "VALIDATION_ERROR",
      { details: { confirmations } },
    );
  }

  // Mark reservation as verified
  await markReservationAsVerified(targetReservationId, txHash);

  // Notify restaurant owner
  if (reservation.restaurant?.ownerEmail) {
    await notifyOwnerOfVerification({
      ownerEmail: reservation.restaurant.ownerEmail,
      guestName: reservation.guestName,
      partySize: reservation.partySize,
      startTime: reservation.startTime,
    });
  }

  logger.info(`Reservation verified with tx ${txHash}`, {
    reservationId: targetReservationId,
    txHash,
  });

  return {
    body: successResponse(
      { txHash, confirmations },
      { message: "Crypto payment verified successfully" },
    ) as CheckoutResponse,
    status: 200,
    _frontendCallbackUrl: frontendCallbackUrl,
    _reservationId: targetReservationId,
    _txHash: txHash,
  } as unknown as { body: CheckoutResponse; status: number };
}
