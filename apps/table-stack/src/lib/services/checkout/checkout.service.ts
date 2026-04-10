/**
 * Checkout Service
 *
 * Core business logic for crypto payment checkout.
 * Encapsulates: replay guard management, on-chain verification,
 * reservation updates, and notification dispatch.
 *
 * Extracted from API route to improve testability and reusability.
 */

import { getDb, restaurantReservations, eq } from "@repo/database";
import { createPublicClient, http, type Hex } from "viem";
import { base } from "viem/chains";
import {
  AppConfig,
  Logger,
  dispatchTask,
  releaseReplayProcessingLock,
  confirmReplayGuard,
  rollbackReplayGuard,
  tryAcquireReplayProcessingLock,
  isReplayAllowed,
} from "@repo/shared";
import { verifyTransaction } from "@repo/shared/utils/web3-verification";
import { CheckoutError } from "./validation";

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
   * 3. Verify on-chain transaction
   * 4. Update reservation in DB
   * 5. Confirm replay guard
   * 6. Dispatch notifications
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
      requestOrigin,
    } = input;

    // Fetch reservation
    const reservation = await getDb().query.restaurantReservations.findFirst({
      where: eq(restaurantReservations.id, reservationId),
      with: {
        restaurant: true,
      },
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

    // Validate payment mode
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

    // REPLAY GUARD: Two-phase commit
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

    // CRITICAL: Wrap verification and DB update in try...finally
    // to ensure lock release on failure
    let confirmed = false;
    let confirmations = 0;

    try {
      // On-chain verification
      const isEscrowPayment = AppConfig.isEscrowMode();
      const slippageBps =
        paymentCurrency === "ETH" && !isEscrowPayment
          ? AppConfig.getSlippageBps()
          : undefined;

      const verificationResult = await verifyTransaction({
        txHash: txHash as Hex,
        expectedValue,
        expectedRecipient: isEscrowPayment
          ? (AppConfig.getEscrowContractAddress() as Hex)
          : (reservation.restaurant!.walletAddress as Hex),
        paymentCurrency,
        orderId: reservationId,
        isEscrowPayment,
        slippageBps,
      });

      if (!verificationResult.success) {
        await rollbackReplayGuard(txHash as Hex);
        throw new CheckoutError(
          verificationResult.error || "Transaction verification failed",
          400,
          "VALIDATION_ERROR",
        );
      }

      // Additional ETH transaction data check
      if (paymentCurrency !== "USDC") {
        await this.verifyEthTransactionData(txHash, reservationId);
      }

      confirmations = verificationResult.receipt?.confirmations || 0;
      if (confirmations < 1) {
        throw new CheckoutError(
          "Waiting for more confirmations",
          400,
          "VALIDATION_ERROR",
          { details: { confirmations } },
        );
      }

      // Mark reservation as verified
      await this.markVerified(reservationId, txHash);

      // Confirm replay guard (upgrades processing lock to confirmed state)
      await confirmReplayGuard(txHash as Hex);
      confirmed = true;
    } finally {
      if (!confirmed) {
        await releaseReplayProcessingLock(txHash as Hex).catch(() => {
          logger.warn("Failed to release processing lock (TTL will expire)");
        });
      }
    }

    // Dispatch notifications (fire-and-forget)
    await this.dispatchNotifications({
      reservation,
      reservationId,
      txHash,
      requestOrigin,
      frontendCallbackUrl,
    });

    return {
      txHash,
      confirmations,
      reservationId,
    };
  }

  /**
   * Verify ETH transaction data contains the reservation ID
   */
  private async verifyEthTransactionData(
    txHash: string,
    reservationId: string,
  ): Promise<void> {
    const rpcUrl = AppConfig.getBaseRpcUrl();
    if (!rpcUrl && process.env.NODE_ENV === "production") {
      throw new CheckoutError(
        "BASE_RPC_URL not configured in production",
        500,
        "CONFIGURATION_ERROR",
      );
    }

    const client = createPublicClient({
      transport: http(rpcUrl || "https://mainnet.base.org"),
      chain: base,
    });

    const tx = await client.getTransaction({ hash: txHash as Hex });

    if (tx.input && tx.input !== "0x" && tx.input.length > 2) {
      try {
        const { hexToString } = await import("viem");
        const decodedData = hexToString(tx.input);
        if (decodedData !== reservationId) {
          throw new CheckoutError(
            "Transaction data mismatch",
            400,
            "VALIDATION_ERROR",
            {
              details: { expected: reservationId, received: decodedData },
            },
          );
        }
      } catch (err) {
        if (err instanceof CheckoutError) throw err;
        logger.warn("Could not decode transaction data for ETH payment");
      }
    }
  }

  /**
   * Mark reservation as verified in the database
   */
  private async markVerified(
    reservationId: string,
    txHash: string,
  ): Promise<void> {
    await getDb()
      .update(restaurantReservations)
      .set({
        isVerified: true,
        status: "confirmed",
        paymentTxHash: txHash,
      })
      .where(eq(restaurantReservations.id, reservationId));
  }

  /**
   * Dispatch email and webhook notifications
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

    // Email to restaurant owner
    if (reservation.restaurant?.ownerEmail) {
      dispatchTask(
        "send_reservation_email",
        {
          reservationId,
          guestEmail: reservation.guestEmail || "",
          guestName: reservation.guestName || "",
          restaurantName: reservation.restaurant?.name || "Restaurant",
          partySize: reservation.partySize || 0,
          startTime:
            reservation.startTime?.toISOString() || new Date().toISOString(),
          verificationToken: "",
          isShadow: false,
          origin: requestOrigin,
        },
        `checkout-notify:${txHash}`,
      ).catch((err: Error) => {
        logger.warn("Failed to dispatch owner notification (non-fatal)", {
          error: err.message,
        });
      });
    }

    // Webhook callback
    if (frontendCallbackUrl) {
      dispatchTask(
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
