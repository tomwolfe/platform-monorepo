/**
 * Checkout Validation Utilities
 *
 * Extracted from checkout.service.ts
 * Handles Zod validation, EIP-712 signature verification, and slippage checks.
 *
 * @see Task 5: Refactor Monolithic Service Files
 */

import { parseUnits, verifyTypedData, type Address, type Hex } from "viem";
import {
  usdToCryptoBigInt,
  isWithinSlippage,
} from "@repo/shared/utils/crypto-price";
import { AppConfig } from "@repo/shared";

// ============================================================================
// EIP-712 DOMAIN & TYPES
// ============================================================================

export const EIP712_DOMAIN = {
  name: "TableStack",
  version: "1",
  chainId: 8453, // Base mainnet
} as const;

export const EIP712_TYPES = {
  Reservation: [
    { name: "reservationId", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const DEADLINE_TOLERANCE_SECONDS = 5 * 60;

// ============================================================================
// CHECKOUT ERROR
// ============================================================================

export class CheckoutError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CheckoutError";
  }
}

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validate reservation deadline with tolerance window
 */
export function validateDeadline(deadline: number | undefined): void {
  if (!deadline) return;

  const now = Math.floor(Date.now() / 1000);
  if (now > deadline + DEADLINE_TOLERANCE_SECONDS) {
    throw new CheckoutError("Signature has expired", 400, "VALIDATION_ERROR", {
      details: {
        deadline: new Date(deadline * 1000).toISOString(),
        currentTime: new Date(now * 1000).toISOString(),
      },
    });
  }
}

/**
 * Validate chain ID (must be Base mainnet)
 */
export function validateChainId(chainId: number | undefined): void {
  if (chainId && chainId !== 8453) {
    throw new CheckoutError(
      "Invalid chain ID. Must be Base (8453)",
      400,
      "VALIDATION_ERROR",
      { details: { received: chainId, expected: 8453 } },
    );
  }
}

/**
 * Validate payment mode configuration
 */
export function validatePaymentMode(reservation: {
  restaurant?: { walletAddress?: string | null } | null;
}): void {
  if (AppConfig.isDirectP2PMode() && !reservation.restaurant?.walletAddress) {
    throw new CheckoutError(
      "Restaurant wallet address not configured - cannot accept P2P payment",
      400,
      "VALIDATION_ERROR",
    );
  }

  if (AppConfig.isEscrowMode() && !AppConfig.getEscrowContractAddress()) {
    throw new CheckoutError(
      "Escrow contract address not configured - cannot process escrow payment",
      400,
      "VALIDATION_ERROR",
    );
  }

  if (AppConfig.isPaymentDisabled()) {
    throw new CheckoutError(
      "Web3 payments are disabled. Please use traditional payment methods.",
      400,
      "VALIDATION_ERROR",
    );
  }
}

// ============================================================================
// SIGNATURE VERIFICATION
// ============================================================================

interface VerifySignatureParams {
  signature: string | undefined;
  walletAddress: string | undefined;
  targetReservationId: string;
  reservation: {
    depositAmount: number | null;
    restaurant?: { walletAddress?: string | null } | null;
  };
  paymentCurrency: string;
  signedAmount: string | undefined;
  deadline: number | undefined;
}

/**
 * Verify EIP-712 typed data signature
 */
export async function verifySignature(
  params: VerifySignatureParams,
): Promise<void> {
  const {
    signature,
    walletAddress,
    targetReservationId,
    reservation,
    paymentCurrency,
    signedAmount,
    deadline,
  } = params;

  if (!signature) {
    throw new CheckoutError(
      "EIP-712 signature is required",
      400,
      "VALIDATION_ERROR",
    );
  }

  if (!walletAddress) {
    return; // Signature present but no wallet - skip verification
  }

  try {
    const depositUsdCentsForSig = reservation.depositAmount || 0;

    let amountToVerify: bigint;
    if (signedAmount) {
      amountToVerify = BigInt(signedAmount);
    } else if (paymentCurrency === "ETH") {
      amountToVerify = await usdToCryptoBigInt(
        BigInt(depositUsdCentsForSig),
        "ETH",
      );
    } else {
      const dollars = Math.floor(depositUsdCentsForSig / 100);
      const centsRemainder = depositUsdCentsForSig % 100;
      amountToVerify = parseUnits(
        `${dollars}.${String(centsRemainder).padStart(2, "0")}0000`,
        6,
      );
    }

    const deadlineToVerify =
      deadline || Math.floor(Date.now() / 1000) + 15 * 60;

    const isValidSignature = await verifyTypedData({
      address: walletAddress as Address,
      signature: signature as Hex,
      domain: {
        name: EIP712_DOMAIN.name,
        version: EIP712_DOMAIN.version,
        chainId: EIP712_DOMAIN.chainId,
      },
      types: EIP712_TYPES,
      primaryType: "Reservation",
      message: {
        reservationId: targetReservationId,
        amount: amountToVerify,
        deadline: BigInt(deadlineToVerify),
      },
    });

    if (!isValidSignature) {
      throw new CheckoutError(
        "Invalid EIP-712 signature",
        400,
        "VALIDATION_ERROR",
      );
    }

    // Slippage check
    if (
      signedAmount &&
      paymentCurrency === "ETH" &&
      AppConfig.isDirectP2PMode()
    ) {
      const expectedValue = await usdToCryptoBigInt(
        BigInt(depositUsdCentsForSig),
        "ETH",
      );
      const slippageBps = AppConfig.getSlippageBps();
      if (!isWithinSlippage(BigInt(signedAmount), expectedValue, slippageBps)) {
        throw new CheckoutError(
          "Signed amount is outside acceptable slippage tolerance. Please sign a new checkout with the current price.",
          400,
          "VALIDATION_ERROR",
          {
            details: {
              signedAmount,
              expectedValue: expectedValue.toString(),
              slippageBps,
            },
          },
        );
      }
    }
  } catch (err) {
    if (err instanceof CheckoutError) throw err;
    throw new CheckoutError(
      "Signature verification failed",
      400,
      "VALIDATION_ERROR",
      {
        details: {
          error: err instanceof Error ? err.message : "Unknown error",
        },
      },
    );
  }
}

/**
 * Calculate expected crypto amount from USD cents
 */
export async function calculateExpectedCryptoAmount(
  depositUsdCents: number,
  paymentCurrency: string,
): Promise<bigint> {
  if (paymentCurrency === "ETH") {
    return usdToCryptoBigInt(BigInt(depositUsdCents), "ETH");
  }

  const dollars = Math.floor(depositUsdCents / 100);
  const centsRemainder = depositUsdCents % 100;
  return parseUnits(
    `${dollars}.${String(centsRemainder).padStart(2, "0")}0000`,
    6,
  );
}
