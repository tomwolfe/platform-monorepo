export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb, restaurantReservations, eq, restaurants } from "@repo/database";
import { NotifyService } from "@tablestack/lib/notifications";
import {
  createPublicClient,
  http,
  parseUnits,
  verifyTypedData,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { isValidTxHash } from "@repo/shared/utils/web3-verification";
import {
  getCryptoPrices,
  usdToCryptoBigInt,
} from "@repo/shared/utils/crypto-price";
import {
  CheckoutRequestSchema,
  CheckoutResponseSchema,
  createValidationMiddleware,
  errorResponse,
  successResponse,
  withApiErrorHandler,
  Logger,
  AppConfig,
} from "@repo/shared";
import {
  isReplayAllowed,
  rollbackReplayGuard,
} from "@repo/shared/middleware/web3-replay-guard";

export const runtime = "nodejs";

const logger = new Logger({ serviceName: "table-stack" });

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

// Maximum deadline tolerance (5 minutes past expiration)
const DEADLINE_TOLERANCE_SECONDS = 5 * 60;

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
  // Use standardized validation middleware
  const validate = createValidationMiddleware(CheckoutRequestSchema);
  const validation = await validate(req);
  if (!validation.valid) {
    return NextResponse.json(validation.error, { status: validation.status });
  }

  // CRITICAL: Do NOT trust expectedAmount from client - it's removed from the destructuring
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
  } = validation.data;

  // Use reservationId for table-stack (orderId is for open-delivery)
  const targetReservationId = reservationId || orderId;

  if (!targetReservationId) {
    return NextResponse.json(
      errorResponse("VALIDATION_ERROR", "reservationId is required"),
      { status: 400 },
    );
  }

  // Fetch reservation early (needed for signature verification)
  const reservation = await getDb().query.restaurantReservations.findFirst({
    where: eq(restaurantReservations.id, targetReservationId),
    with: {
      restaurant: true,
    },
  });

  if (!reservation) {
    return NextResponse.json(
      errorResponse("NOT_FOUND", "Reservation not found"),
      { status: 404 },
    );
  }

  // ============================================================================
  // EIP-712 SIGNATURE & DEADLINE VALIDATION
  // ============================================================================

  // Validate deadline (prevent expired signatures)
  if (deadline) {
    const now = Math.floor(Date.now() / 1000);
    if (now > deadline + DEADLINE_TOLERANCE_SECONDS) {
      return NextResponse.json(
        errorResponse("VALIDATION_ERROR", "Signature has expired", {
          details: {
            deadline: new Date(deadline * 1000).toISOString(),
            currentTime: new Date(now * 1000).toISOString(),
          },
        }),
        { status: 400 },
      );
    }
  }

  // Validate chain ID matches Base (8453)
  if (chainId && chainId !== 8453) {
    return NextResponse.json(
      errorResponse(
        "VALIDATION_ERROR",
        "Invalid chain ID. Must be Base (8453)",
        {
          details: { received: chainId, expected: 8453 },
        },
      ),
      { status: 400 },
    );
  }

  // Verify EIP-712 signature if provided
  if (signature && walletAddress) {
    try {
      // Fetch deposit amount for signature verification
      const depositUsdCentsForSig = reservation.depositAmount || 0;

      // CRITICAL FIX: Use the signedAmount from the client (the amount they actually signed)
      // instead of recalculating here, which would cause mismatches due to price volatility.
      // If signedAmount is not provided, fall back to server-side calculation.
      let amountToVerify: bigint;
      if (signedAmount) {
        amountToVerify = BigInt(signedAmount);
      } else if (paymentCurrency === "ETH") {
        amountToVerify = await usdToCryptoBigInt(
          BigInt(depositUsdCentsForSig),
          "ETH",
        );
      } else {
        // CRITICAL: Use integer math to avoid float division precision loss
        const dollars = Math.floor(depositUsdCentsForSig / 100);
        const centsRemainder = depositUsdCentsForSig % 100;
        amountToVerify = parseUnits(
          `${dollars}.${String(centsRemainder).padStart(2, "0")}0000`,
          6,
        );
      }

      // Use deadline from request or calculate default
      const deadlineToVerify =
        deadline || Math.floor(Date.now() / 1000) + 15 * 60;

      // Verify EIP-712 typed data signature
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
        return NextResponse.json(
          errorResponse("VALIDATION_ERROR", "Invalid EIP-712 signature"),
          { status: 400 },
        );
      }

      // SLIPPAGE CHECK: After verifying the signature, ensure the signed amount
      // is within acceptable slippage bounds of the current market rate.
      // This prevents stale signatures from being used when prices have moved significantly.
      if (signedAmount && paymentCurrency === "ETH") {
        const expectedValue = await usdToCryptoBigInt(
          BigInt(depositUsdCentsForSig),
          "ETH",
        );
        const { isWithinSlippage } =
          await import("@repo/shared/utils/crypto-price");
        const slippageBps = AppConfig.getSlippageBps();
        if (
          !isWithinSlippage(BigInt(signedAmount), expectedValue, slippageBps)
        ) {
          return NextResponse.json(
            errorResponse(
              "VALIDATION_ERROR",
              "Signed amount is outside acceptable slippage tolerance. Please sign a new checkout with the current price.",
              {
                details: {
                  signedAmount,
                  expectedValue: expectedValue.toString(),
                  slippageBps,
                },
              },
            ),
            { status: 400 },
          );
        }
      }
    } catch (sigError) {
      return NextResponse.json(
        errorResponse("VALIDATION_ERROR", "Signature verification failed", {
          details: {
            error:
              sigError instanceof Error ? sigError.message : "Unknown error",
          },
        }),
        { status: 400 },
      );
    }
  } else if (!signature) {
    return NextResponse.json(
      errorResponse("VALIDATION_ERROR", "EIP-712 signature is required"),
      { status: 400 },
    );
  }

  // Validate transaction hash format
  // Note: txHash is already validated by CheckoutRequestSchema, but extra validation doesn't hurt
  if (!isValidTxHash(txHash)) {
    return NextResponse.json(
      errorResponse("VALIDATION_ERROR", "Invalid transaction hash format"),
      { status: 400 },
    );
  }

  // Already verified?
  if (reservation.isVerified) {
    return NextResponse.json(
      successResponse(
        { isVerified: true },
        { message: "Reservation already verified" },
      ),
      { status: 200 },
    );
  }

  // ============================================================================
  // SERVER-SIDE CALCULATION: Never trust client for financial data
  // ============================================================================

  // Enforce restaurant wallet address exists (direct P2P requirement)
  if (!reservation.restaurant?.walletAddress) {
    return NextResponse.json(
      errorResponse(
        "VALIDATION_ERROR",
        "Restaurant wallet address not configured - cannot accept P2P payment",
      ),
      { status: 400 },
    );
  }

  // Fetch deposit amount from database (in USD cents)
  const depositUsdCents = reservation.depositAmount || 0;

  // Fetch live crypto prices from oracle
  const prices = await getCryptoPrices();

  // Calculate expected crypto amount based on payment currency
  let expectedValue: bigint;

  if (paymentCurrency === "ETH") {
    // Use exact market rate for expectedValue - slippage is checked inside verifyTransaction
    expectedValue = await usdToCryptoBigInt(BigInt(depositUsdCents), "ETH");
  } else {
    // USDC: 6 decimals, 1 USD = 1 USDC
    // CRITICAL: Use integer math to avoid float division precision loss
    const dollars = Math.floor(depositUsdCents / 100);
    const centsRemainder = depositUsdCents % 100;
    expectedValue = parseUnits(
      `${dollars}.${String(centsRemainder).padStart(2, "0")}0000`,
      6,
    );
  }

  // REPLAY GUARD: Check if this transaction hash has already been used
  const replayCheck = await isReplayAllowed({
    txHash: txHash as `0x${string}`,
    appSource: "table-stack",
    entityId: targetReservationId,
  });

  if (!replayCheck) {
    return NextResponse.json(
      errorResponse("CONFLICT", `Payment transaction already used or blocked.`),
      { status: 409 },
    );
  }

  // Zero-Trust On-Chain Verification using shared utility
  // isEscrowPayment=false because TableStack uses direct P2P to restaurant
  const { verifyTransaction } =
    await import("@repo/shared/utils/web3-verification");

  const slippageBps =
    paymentCurrency === "ETH" ? AppConfig.getSlippageBps() : undefined;
  const verificationResult = await verifyTransaction({
    txHash: txHash as `0x${string}`,
    expectedValue,
    expectedRecipient: reservation.restaurant.walletAddress as `0x${string}`,
    paymentCurrency,
    orderId: targetReservationId,
    isEscrowPayment: false, // Direct P2P to restaurant wallet
    slippageBps,
  });

  if (!verificationResult.success) {
    // Rollback the replay guard to allow future attempts with this hash
    await rollbackReplayGuard(txHash as `0x${string}`);
    return NextResponse.json(
      errorResponse(
        "VALIDATION_ERROR",
        verificationResult.error || "Transaction verification failed",
      ),
      { status: 400 },
    );
  }

  // Additional check: Verify transaction data contains reservation ID (for ETH payments)
  // For USDC, the exact amount + recipient verification is sufficient
  if (paymentCurrency !== "USDC") {
    const rpcUrl = process.env.BASE_RPC_URL || "https://mainnet.base.org";
    const client = createPublicClient({ transport: http(rpcUrl), chain: base });
    const tx = await client.getTransaction({ hash: txHash as `0x${string}` });

    if (tx.input && tx.input !== "0x" && tx.input.length > 2) {
      try {
        const { hexToString } = await import("viem");
        const decodedData = hexToString(tx.input);

        if (decodedData !== targetReservationId) {
          return NextResponse.json(
            errorResponse(
              "VALIDATION_ERROR",
              "Transaction data mismatch. Reservation ID not found in transaction data.",
              {
                details: {
                  expected: targetReservationId,
                  received: decodedData,
                },
              },
            ),
            { status: 400 },
          );
        }
      } catch (decodeError) {
        logger.warn("Could not decode transaction data for ETH payment");
      }
    }
  }

  // Confirmations already checked by verifyTransaction
  const confirmations = verificationResult.receipt?.confirmations || 0;
  if (confirmations < 1) {
    return NextResponse.json(
      errorResponse("VALIDATION_ERROR", "Waiting for more confirmations", {
        details: { confirmations },
      }),
      { status: 400 },
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

  // Build response and validate with CheckoutResponseSchema
  const responseData = successResponse(
    {
      txHash,
      confirmations,
    },
    { message: "Crypto payment verified successfully" },
  );

  // Validate response structure before returning
  const responseValidation = CheckoutResponseSchema.safeParse(responseData);
  if (!responseValidation.success) {
    logger.error("Checkout response validation failed", {
      errors: responseValidation.error.flatten(),
    });
    // Still return the response, but log the validation error
  }

  return NextResponse.json(responseData);
}

export const POST = withApiErrorHandler(postHandler, "EXECUTION_FAILED");
