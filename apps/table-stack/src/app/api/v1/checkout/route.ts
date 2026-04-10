export const dynamic = "force-dynamic";
import { NextRequest, NextResponse, after } from "next/server";
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
  withRetry,
} from "@repo/shared";
import {
  isReplayAllowed,
  rollbackReplayGuard,
  tryAcquireReplayProcessingLock,
  confirmReplayGuard,
} from "@repo/shared/middleware/web3-replay-guard";

export const runtime = "nodejs";

const logger = new Logger({ serviceName: "table-stack" });

// ============================================================================
// WEBHOOK CONFIGURATION
// Phase 2.2: Webhook Fallback for Missed Frontend Callbacks
// ============================================================================

/**
 * Send a webhook notification to the frontend callback URL.
 * This allows external frontends (or mobile apps) to update their state
 * even if the initial HTTP connection dropped.
 *
 * @param webhookUrl - The frontend callback URL
 * @param payload - The webhook payload
 * @param logger - Logger instance for tracking
 */
async function sendWebhookCallback(
  webhookUrl: string,
  payload: {
    success: boolean;
    reservationId: string;
    txHash?: string;
    status?: string;
    message?: string;
    timestamp: string;
  },
  logger: Logger,
): Promise<void> {
  try {
    await withRetry(
      async () => {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Webhook-Source": "table-stack-checkout",
            "X-Reservation-Id": payload.reservationId,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });

        if (!response.ok) {
          throw new Error(
            `Webhook returned ${response.status}: ${response.statusText}`,
          );
        }
      },
      {
        maxRetries: 2,
        initialDelay: 1000,
        maxDelay: 5000,
        shouldRetry: (error) => {
          // Don't retry client errors (4xx)
          return !error.message?.includes("returned 4");
        },
      },
    );

    logger.info("Webhook callback sent successfully", {
      webhookUrl,
      reservationId: payload.reservationId,
    });
  } catch (error) {
    // Log but don't fail the request - webhook is best-effort
    logger.warn("Webhook callback failed (non-fatal)", {
      webhookUrl,
      reservationId: payload.reservationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

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
    frontendCallbackUrl,
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
      // Only applies in DIRECT_P2P mode (escrow handles slippage differently).
      if (
        signedAmount &&
        paymentCurrency === "ETH" &&
        AppConfig.isDirectP2PMode()
      ) {
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
  // T1.3: CONFIG-DRIVEN PAYMENT MODE VALIDATION
  // ============================================================================

  // In DIRECT_P2P mode, enforce restaurant wallet address exists
  if (AppConfig.isDirectP2PMode() && !reservation.restaurant?.walletAddress) {
    return NextResponse.json(
      errorResponse(
        "VALIDATION_ERROR",
        "Restaurant wallet address not configured - cannot accept P2P payment",
      ),
      { status: 400 },
    );
  }

  // In ESCROW mode, ensure escrow contract is configured
  if (AppConfig.isEscrowMode() && !AppConfig.getEscrowContractAddress()) {
    return NextResponse.json(
      errorResponse(
        "VALIDATION_ERROR",
        "Escrow contract address not configured - cannot process escrow payment",
      ),
      { status: 400 },
    );
  }

  // In DISABLED mode, reject Web3 checkout
  if (AppConfig.isPaymentDisabled()) {
    return NextResponse.json(
      errorResponse(
        "VALIDATION_ERROR",
        "Web3 payments are disabled. Please use traditional payment methods.",
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

  // REPLAY GUARD: Two-phase commit to prevent bricked transaction hashes
  // PHASE 1: Acquire a processing lock with short TTL (120s)
  const processingLockAcquired = await tryAcquireReplayProcessingLock(
    txHash as `0x${string}`,
  );

  if (!processingLockAcquired) {
    return NextResponse.json(
      errorResponse(
        "CONFLICT",
        `Payment transaction is currently being processed by another request.`,
      ),
      { status: 409 },
    );
  }

  // PHASE 1b: Atomically register the txHash in DB to prevent replay attacks
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
  // T1.3: Read payment mode from AppConfig instead of hardcoding
  const { verifyTransaction } =
    await import("@repo/shared/utils/web3-verification");

  const isEscrowPayment = AppConfig.isEscrowMode();
  const slippageBps =
    paymentCurrency === "ETH" && !isEscrowPayment
      ? AppConfig.getSlippageBps()
      : undefined;
  const verificationResult = await verifyTransaction({
    txHash: txHash as `0x${string}`,
    expectedValue,
    expectedRecipient: isEscrowPayment
      ? (AppConfig.getEscrowContractAddress() as `0x${string}`)
      : (reservation.restaurant.walletAddress as `0x${string}`),
    paymentCurrency,
    orderId: targetReservationId,
    isEscrowPayment,
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
    const rpcUrl = AppConfig.getBaseRpcUrl() || "https://mainnet.base.org";
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

  // PHASE 2 (Commit): After DB update succeeds, confirm the replay guard
  // This upgrades the processing lock to a confirmed state with 24h TTL
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

  // PHASE 2.2: Send webhook callback if provided
  // This allows external frontends to update their state even if the
  // initial HTTP connection dropped (e.g., user closed browser tab)
  if (frontendCallbackUrl) {
    // CRITICAL: Wrap in after() to ensure Vercel doesn't terminate
    // the serverless function before the webhook completes
    after(() => {
      sendWebhookCallback(
        frontendCallbackUrl,
        {
          success: true,
          reservationId: targetReservationId,
          txHash,
          status: "confirmed",
          message: "Crypto payment verified successfully",
          timestamp: new Date().toISOString(),
        },
        logger,
      ).catch(() => {
        // Already logged in sendWebhookCallback
      });
    });
  }

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
