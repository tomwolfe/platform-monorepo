/**
 * Web3 Transaction Verification
 *
 * Extracted from checkout.service.ts
 * Handles on-chain transaction verification and data validation.
 *
 * @see Task 5: Refactor Monolithic Service Files
 * @see T1: Unify Web3 Logic - Audit Roadmap
 */

import { hexToString } from "viem";
import { getPublicClient } from "@repo/web3";
import {
  isValidTxHash,
  verifyTransaction,
} from "@repo/shared/utils/web3-verification";
import { AppConfig, ERROR_CODES } from "@repo/shared";
import {
  safeToHex,
  safeToAddress,
  validateTransactionHash,
} from "@repo/shared/web3/verifier";
import { AppConfig as SharedAppConfig } from "@repo/shared";
import { rollbackReplayGuard } from "@repo/shared/middleware/web3-replay-guard";
import { Logger } from "@repo/shared";
import { CheckoutError } from "./validation";

const logger = new Logger({ serviceName: "checkout-web3-verify" });

// ============================================================================
// TRANSACTION VERIFICATION
// ============================================================================

interface VerifyOnChainTransactionParams {
  txHash: string;
  expectedValue: bigint;
  reservation: {
    restaurant?: { walletAddress?: string | null } | null;
  };
  paymentCurrency: string;
  targetReservationId: string;
}

/**
 * Verify on-chain transaction details
 */
export async function verifyOnChainTransaction(
  params: VerifyOnChainTransactionParams,
): Promise<Awaited<ReturnType<typeof verifyTransaction>>> {
  const {
    txHash,
    expectedValue,
    reservation,
    paymentCurrency,
    targetReservationId,
  } = params;

  const isEscrowPayment = SharedAppConfig.isEscrowMode();
  const slippageBps =
    paymentCurrency === "ETH" && !isEscrowPayment
      ? SharedAppConfig.getSlippageBps()
      : undefined;

  const result = await verifyTransaction({
    txHash: safeToHex(txHash, "txHash"),
    expectedValue,
    expectedRecipient: isEscrowPayment
      ? safeToHex(
          SharedAppConfig.getEscrowContractAddress(),
          "escrowContractAddress",
        )
      : safeToAddress(reservation.restaurant?.walletAddress),
    paymentCurrency,
    orderId: targetReservationId,
    isEscrowPayment,
    slippageBps,
  });

  if (!result.success) {
    await rollbackReplayGuard(safeToHex(txHash, "txHash"));
    throw new CheckoutError(
      result.error || "Transaction verification failed",
      400,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  // Verify transaction data contains reservation ID for ETH payments
  if (paymentCurrency !== "USDC") {
    await verifyTransactionData(txHash, targetReservationId);
  }

  return result;
}

/**
 * Verify transaction data contains expected reservation ID
 */
export async function verifyTransactionData(
  txHash: string,
  targetReservationId: string,
): Promise<void> {
  const client = getPublicClient("base");
  const tx = await client.getTransaction({ hash: safeToHex(txHash, "txHash") });

  if (tx.input && tx.input !== "0x" && tx.input.length > 2) {
    try {
      const decodedData = hexToString(tx.input);
      if (decodedData !== targetReservationId) {
        throw new CheckoutError(
          "Transaction data mismatch. Reservation ID not found in transaction data.",
          400,
          ERROR_CODES.VALIDATION_ERROR,
          {
            details: {
              expected: targetReservationId,
              received: decodedData,
            },
          },
        );
      }
    } catch (decodeError) {
      if (decodeError instanceof CheckoutError) throw decodeError;
      logger.warn("Could not decode transaction data for ETH payment");
    }
  }
}

// Re-export validateTransactionHash for backward compatibility
// Now uses the unified implementation from @repo/shared/web3/verifier
export { validateTransactionHash };
