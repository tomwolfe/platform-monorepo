/**
 * Web3 Transaction Verification
 *
 * Extracted from checkout.service.ts
 * Handles on-chain transaction verification and data validation.
 *
 * @see Task 5: Refactor Monolithic Service Files
 */

import { hexToString, isHex, isAddress } from "viem";
import { getPublicClient } from "@repo/web3";
import {
  isValidTxHash,
  verifyTransaction,
} from "@repo/shared/utils/web3-verification";
import { AppConfig } from "@repo/shared";
import { CheckoutError } from "./validation";
import { rollbackReplayGuard } from "@repo/shared/middleware/web3-replay-guard";
import { Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "checkout-web3-verify" });

// ============================================================================
// SAFE HEX VALIDATION
// ============================================================================

/**
 * Safely coerce a string to a 0x-prefixed hex string.
 * Throws a controlled CheckoutError if the format is invalid.
 */
function safeToHex(value: string, label: string): `0x${string}` {
  if (!isHex(value)) {
    throw new CheckoutError(
      `Invalid hex format for ${label}: expected 0x-prefixed string`,
      400,
      "VALIDATION_ERROR",
      { details: { label, value } },
    );
  }
  return value as `0x${string}`;
}

/**
 * Safely coerce a string to an Ethereum address.
 * Throws a controlled CheckoutError if the format is invalid.
 */
function safeToAddress(value: string | null | undefined): `0x${string}` {
  if (!value || !isAddress(value)) {
    throw new CheckoutError(
      `Invalid Ethereum address format`,
      400,
      "VALIDATION_ERROR",
      { details: { value } },
    );
  }
  return value as `0x${string}`;
}

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

  const isEscrowPayment = AppConfig.isEscrowMode();
  const slippageBps =
    paymentCurrency === "ETH" && !isEscrowPayment
      ? AppConfig.getSlippageBps()
      : undefined;

  const result = await verifyTransaction({
    txHash: safeToHex(txHash, "txHash"),
    expectedValue,
    expectedRecipient: isEscrowPayment
      ? safeToHex(AppConfig.getEscrowContractAddress(), "escrowContractAddress")
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
      "VALIDATION_ERROR",
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
          "VALIDATION_ERROR",
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

/**
 * Validate transaction hash format
 */
export function validateTransactionHash(txHash: string): void {
  if (!isValidTxHash(txHash)) {
    throw new CheckoutError(
      "Invalid transaction hash format",
      400,
      "VALIDATION_ERROR",
    );
  }
}
