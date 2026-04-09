/**
 * Checkout Service
 *
 * Extracts business logic from the /api/v1/checkout route handler
 * to improve cold-start performance, testability, and maintainability.
 *
 * @see TIER 2.4: Extract Route Handlers to Service Layer
 */

import { getDb, restaurantReservations, eq } from "@repo/database";
import { NotifyService } from "@tablestack/lib/notifications";
import {
  createPublicClient,
  http,
  parseUnits,
  verifyTypedData,
  hexToString,
} from "viem";
import { base } from "viem/chains";
import { isValidTxHash } from "@repo/shared/utils/web3-verification";
import {
  getCryptoPrices,
  usdToCryptoBigInt,
  isWithinSlippage,
} from "@repo/shared/utils/crypto-price";
import {
  errorResponse,
  successResponse,
  Logger,
  AppConfig,
} from "@repo/shared";
import {
  isReplayAllowed,
  rollbackReplayGuard,
  tryAcquireReplayProcessingLock,
  confirmReplayGuard,
} from "@repo/shared/middleware/web3-replay-guard";
import { verifyTransaction } from "@repo/shared/utils/web3-verification";
import type { CheckoutRequest, CheckoutResponse } from "@repo/shared";

const logger = new Logger({ serviceName: "checkout-service" });

// EIP-712 Domain for signature verification (must match client)
const EIP712_DOMAIN = {
  name: "TableStack",
  version: "1",
  chainId: 8453, // Base mainnet
} as const;

const EIP712_TYPES = {
  Reservation: [
    { name: "reservationId", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const DEADLINE_TOLERANCE_SECONDS = 5 * 60;

// ============================================================================
// ERROR TYPES
// ============================================================================

export class CheckoutError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CheckoutError";
  }

  toResponse() {
    return errorResponse(this.code, this.message, {
      details: this.details,
    });
  }
}

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

  // Validate deadline
  if (deadline) {
    const now = Math.floor(Date.now() / 1000);
    if (now > deadline + DEADLINE_TOLERANCE_SECONDS) {
      throw new CheckoutError(
        "Signature has expired",
        400,
        "VALIDATION_ERROR",
        {
          details: {
            deadline: new Date(deadline * 1000).toISOString(),
            currentTime: new Date(now * 1000).toISOString(),
          },
        },
      );
    }
  }

  // Validate chain ID
  if (chainId && chainId !== 8453) {
    throw new CheckoutError(
      "Invalid chain ID. Must be Base (8453)",
      400,
      "VALIDATION_ERROR",
      { details: { received: chainId, expected: 8453 } },
    );
  }

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
  if (!isValidTxHash(txHash)) {
    throw new CheckoutError(
      "Invalid transaction hash format",
      400,
      "VALIDATION_ERROR",
    );
  }

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
    await rollbackReplayGuard(txHash as `0x${string}`);
    throw new CheckoutError(
      "Waiting for more confirmations",
      400,
      "VALIDATION_ERROR",
      { details: { confirmations } },
    );
  }

  // Mark reservation as verified
  await getDb()
    .update(restaurantReservations)
    .set({
      isVerified: true,
      status: "confirmed",
      paymentTxHash: txHash,
    })
    .where(eq(restaurantReservations.id, targetReservationId));

  // Confirm replay guard
  await confirmReplayGuard(txHash as `0x${string}`);

  // Notify restaurant owner
  if (reservation.restaurant?.ownerEmail) {
    await NotifyService.notifyOwner(reservation.restaurant.ownerEmail, {
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

// ============================================================================
// HELPERS
// ============================================================================

async function verifySignature(params: {
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
}): Promise<void> {
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
      address: walletAddress as `0x${string}`,
      signature: signature as `0x${string}`,
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

function validatePaymentMode(reservation: {
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

async function calculateExpectedCryptoAmount(
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

async function verifyOnChainTransaction(params: {
  txHash: string;
  expectedValue: bigint;
  reservation: {
    restaurant?: { walletAddress?: string | null } | null;
  };
  paymentCurrency: string;
  targetReservationId: string;
}) {
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
    txHash: txHash as `0x${string}`,
    expectedValue,
    expectedRecipient: isEscrowPayment
      ? (AppConfig.getEscrowContractAddress() as `0x${string}`)
      : (reservation.restaurant?.walletAddress as `0x${string}`),
    paymentCurrency,
    orderId: targetReservationId,
    isEscrowPayment,
    slippageBps,
  });

  if (!result.success) {
    await rollbackReplayGuard(txHash as `0x${string}`);
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

async function verifyTransactionData(
  txHash: string,
  targetReservationId: string,
): Promise<void> {
  const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
  const client = createPublicClient({ transport: http(rpcUrl), chain: base });
  const tx = await client.getTransaction({ hash: txHash as `0x${string}` });

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
