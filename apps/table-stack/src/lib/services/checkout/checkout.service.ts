/**
 * Checkout Service - Orchestrator
 *
 * Coordinates the checkout workflow using smaller, pure functions:
 * - validateInput (from validation.ts)
 * - verifyOnChainTransaction (from web3-verify.ts)
 * - markReservationAsVerified (from reservation-update.ts)
 * - notifyOwnerOfVerification (from notifications.ts)
 *
 * The orchestrator maintains the replay guard two-phase commit boundary
 * while delegating implementation details to extracted modules.
 *
 * @see Task 3: Refactor Checkout Service into smaller pure functions
 */

import { getDb, restaurantReservations, eq } from "@repo/database";
import { type Hex } from "viem";
import {
  AppConfig,
  Logger,
  dispatchTask,
  releaseReplayProcessingLock,
  tryAcquireReplayProcessingLock,
  isReplayAllowed,
} from "@repo/shared";
import { CheckoutError } from "./validation";
import { verifyOnChainTransaction } from "./web3-verify";
import { markReservationAsVerified } from "./reservation-update";
import { notifyOwnerOfVerification } from "./notifications";

const logger = new Logger({ serviceName: "checkout-service" });

export interface CheckoutInput {
  txHash: string;
  reservationId: string;
  paymentCurrency: string;
  expectedValue: bigint;
  frontendCallbackUrl?: string;
  requestOrigin: string;
}

export interface CheckoutResult {
  txHash: string;
  confirmations: number;
  reservationId: string;
}

export class CheckoutService {
  /**
   * Process a crypto payment checkout.
   *
   * Implements two-phase commit with replay guard:
   * 1. Acquire processing lock
   * 2. Register replay guard
   * 3. Verify on-chain transaction (delegated to web3-verify.ts)
   * 4. Update reservation in DB (delegated to reservation-update.ts)
   * 5. Confirm replay guard
   * 6. Dispatch notifications (delegated to notifications.ts + dispatchTask)
   *
   * If any step fails before DB commit, the processing lock is released
   * to allow immediate retries.
   */
  async processCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    const {
      txHash,
      reservationId,
      paymentCurrency,
      expectedValue,
      frontendCallbackUrl,
      requestOrigin: _requestOrigin,
    } = input;

    // Step 1: Fetch and validate reservation
    const reservation = await this.fetchReservation(reservationId);

    // Step 2: Acquire replay processing lock (two-phase commit)
    const lockAcquired = await tryAcquireReplayProcessingLock(txHash as Hex);
    if (!lockAcquired) {
      throw new CheckoutError(
        "Payment transaction is currently being processed",
        409,
        "CONFLICT",
      );
    }

    const replayAllowed = await isReplayAllowed({
      txHash: txHash as Hex,
      appSource: "table-stack",
      entityId: reservationId,
    });

    if (!replayAllowed) {
      await releaseReplayProcessingLock(txHash as Hex);
      throw new CheckoutError(
        "Payment transaction already used or blocked",
        409,
        "CONFLICT",
      );
    }

    // Step 3-5: Verify, update, confirm (atomic boundary)
    let confirmed = false;
    let confirmations = 0;

    try {
      // Step 3: On-chain verification (delegated to web3-verify.ts)
      const verificationResult = await verifyOnChainTransaction({
        txHash,
        expectedValue,
        reservation,
        paymentCurrency,
        targetReservationId: reservationId,
      });

      confirmations = verificationResult.receipt?.confirmations || 0;
      if (confirmations < 1) {
        throw new CheckoutError(
          "Waiting for more confirmations",
          400,
          "VALIDATION_ERROR",
          { details: { confirmations } },
        );
      }

      // Step 4-5: Mark verified + confirm replay guard (delegated to reservation-update.ts)
      await markReservationAsVerified(reservationId, txHash);
      confirmed = true;
    } finally {
      if (!confirmed) {
        await releaseReplayProcessingLock(txHash as Hex).catch(() => {
          logger.warn("Failed to release processing lock (TTL will expire)");
        });
      }
    }

    // Step 6: Dispatch notifications (fire-and-forget, non-blocking)
    await this.dispatchNotifications({
      reservation,
      reservationId,
      txHash,
      requestOrigin: _requestOrigin,
      frontendCallbackUrl,
    });

    return { txHash, confirmations, reservationId };
  }

  // ========================================================================
  // PRIVATE HELPERS (orchestration-level, not pure business logic)
  // ========================================================================

  /**
   * Fetch reservation with restaurant details.
   * Validates payment mode configuration.
   */
  private async fetchReservation(reservationId: string) {
    const reservation = await getDb().query.restaurantReservations.findFirst({
      where: eq(restaurantReservations.id, reservationId),
      with: { restaurant: true },
    });

    if (!reservation) {
      throw new CheckoutError("Reservation not found", 404, "NOT_FOUND");
    }

    if (reservation.isVerified) {
      throw new CheckoutError(
        "Reservation already verified",
        200,
        "ALREADY_VERIFIED",
      );
    }

    // Validate payment mode configuration
    if (AppConfig.isDirectP2PMode() && !reservation.restaurant?.walletAddress) {
      throw new CheckoutError(
        "Restaurant wallet address not configured",
        400,
        "VALIDATION_ERROR",
      );
    }

    if (AppConfig.isEscrowMode() && !AppConfig.getEscrowContractAddress()) {
      throw new CheckoutError(
        "Escrow contract address not configured",
        400,
        "VALIDATION_ERROR",
      );
    }

    if (AppConfig.isPaymentDisabled()) {
      throw new CheckoutError(
        "Web3 payments are disabled",
        400,
        "VALIDATION_ERROR",
      );
    }

    return reservation;
  }

  /**
   * Dispatch email and webhook notifications (fire-and-forget).
   * Uses the extracted notifications module where possible.
   */
  private async dispatchNotifications(params: {
    reservation: {
      restaurant?: { ownerEmail?: string | null; name?: string | null } | null;
      guestEmail?: string | null;
      guestName?: string | null;
      partySize?: number | null;
      startTime?: Date | null;
    };
    reservationId: string;
    txHash: string;
    requestOrigin: string;
    frontendCallbackUrl?: string;
  }): Promise<void> {
    const {
      reservation,
      reservationId,
      txHash,
      requestOrigin,
      frontendCallbackUrl,
    } = params;

    // Email to restaurant owner (using extracted notifications module)
    if (reservation.restaurant?.ownerEmail) {
      await notifyOwnerOfVerification({
        ownerEmail: reservation.restaurant.ownerEmail,
        guestName: reservation.guestName || "",
        partySize: reservation.partySize || 0,
        startTime: reservation.startTime || new Date(),
      });
    }

    // Webhook callback (fire-and-forget via dispatchTask)
    if (frontendCallbackUrl) {
      await dispatchTask(
        "send_checkout_webhook",
        {
          webhookUrl: frontendCallbackUrl,
          reservationId,
          txHash,
          status: "confirmed",
          message: "Crypto payment verified successfully",
        },
        `webhook:${txHash}`,
      ).catch((err: Error) => {
        logger.warn("Failed to dispatch webhook callback (non-fatal)", {
          error: err.message,
        });
      });
    }
  }
}

// Export singleton instance
export const checkoutService = new CheckoutService();
