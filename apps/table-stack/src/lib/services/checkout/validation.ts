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
import {
  AppConfig,
  EIP712_DOMAIN,
  EIP712_RESERVATION_TYPES,
  DEADLINE_TOLERANCE_SECONDS,
  CHAIN_IDS,
  ERROR_CODES,
} from "@repo/shared";

// ============================================================================
// EIP-712 DOMAIN & TYPES
// ============================================================================

/**
 * Get the EIP-712 domain with dynamic chainId based on environment.
 *
 * SECURITY: The chainId is dynamically set based on the current network
 * to prevent cross-chain replay attacks. A signature created for Base
 * mainnet (8453) cannot be replayed on Base Sepolia (84532) or vice versa.
 */
export function getEIP712Domain(chainId?: number) {
  const resolvedChainId = chainId ?? getTargetChainId();
  return {
    ...EIP712_DOMAIN,
    chainId: resolvedChainId,
  } as const;
}

/**
 * Resolve the target chainId from environment or default to Base mainnet.
 */
function getTargetChainId(): number {
  const envChainId = process.env.NEXT_PUBLIC_CHAIN_ID;
  if (envChainId) {
    return parseInt(envChainId, 10);
  }
  // Default to Base mainnet in production, Sepolia in development
  return process.env.NODE_ENV === "production"
    ? CHAIN_IDS.BASE_MAINNET
    : CHAIN_IDS.BASE_SEPOLIA;
}

/**
 * Static EIP-712 domain for backward compatibility.
 * @deprecated Use getEIP712Domain() for dynamic chainId support.
 */
export const EIP712_DOMAIN_STATIC = {
  name: EIP712_DOMAIN.name,
  version: EIP712_DOMAIN.version,
  chainId: CHAIN_IDS.BASE_MAINNET, // Base mainnet (use getEIP712Domain() for dynamic chainId)
} as const;

/**
 * Re-export EIP-712 types for backward compatibility.
 */
export const EIP712_TYPES = EIP712_RESERVATION_TYPES;

/**
 * Re-export deadline tolerance for backward compatibility.
 */
export { DEADLINE_TOLERANCE_SECONDS };

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
    throw new CheckoutError(
      "Signature has expired",
      400,
      ERROR_CODES.VALIDATION_ERROR,
      {
        details: {
          deadline: new Date(deadline * 1000).toISOString(),
          currentTime: new Date(now * 1000).toISOString(),
        },
      },
    );
  }
}

/**
 * Validate chain ID (must be Base mainnet)
 */
export function validateChainId(chainId: number | undefined): void {
  if (chainId && chainId !== CHAIN_IDS.BASE_MAINNET) {
    throw new CheckoutError(
      `Invalid chain ID. Must be Base (${CHAIN_IDS.BASE_MAINNET})`,
      400,
      ERROR_CODES.VALIDATION_ERROR,
      { details: { received: chainId, expected: CHAIN_IDS.BASE_MAINNET } },
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
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  if (AppConfig.isEscrowMode() && !AppConfig.getEscrowContractAddress()) {
    throw new CheckoutError(
      "Escrow contract address not configured - cannot process escrow payment",
      400,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  if (AppConfig.isPaymentDisabled()) {
    throw new CheckoutError(
      "Web3 payments are disabled. Please use traditional payment methods.",
      400,
      ERROR_CODES.VALIDATION_ERROR,
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
      ERROR_CODES.VALIDATION_ERROR,
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
        name: EIP712_DOMAIN_STATIC.name,
        version: EIP712_DOMAIN_STATIC.version,
        chainId: EIP712_DOMAIN_STATIC.chainId,
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
        ERROR_CODES.VALIDATION_ERROR,
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
          ERROR_CODES.VALIDATION_ERROR,
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
      ERROR_CODES.VALIDATION_ERROR,
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
