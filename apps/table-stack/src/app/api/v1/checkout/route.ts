export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { usdToCryptoBigInt } from "@repo/shared/utils/crypto-price";
import { CheckoutRequestSchema } from "@repo/shared";
import {
  createValidationMiddleware,
  errorResponse,
  Logger,
  successResponse,
  withUnifiedApiHandler,
} from "@repo/shared";
import {
  checkoutService,
  verifySignature,
  CheckoutError,
} from "@/lib/services/checkout";
import { validateDeadline, validateChainId } from "@/lib/services/checkout";

export const runtime = "nodejs";

const logger = new Logger({ serviceName: "table-stack" });

/**
 * Crypto Payment Verification Endpoint
 *
 * Thin controller that delegates to checkoutService for:
 * - Replay guard management
 * - On-chain transaction verification
 * - Reservation update
 * - Notification dispatch
 */
async function postHandler(req: NextRequest) {
  // Use standardized validation middleware
  const validate = createValidationMiddleware(CheckoutRequestSchema);
  const validation = await validate(req);
  if (!validation.valid) {
    return NextResponse.json(validation.error, { status: validation.status });
  }

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

  const targetReservationId = reservationId || orderId;
  if (!targetReservationId) {
    return NextResponse.json(
      errorResponse("VALIDATION_ERROR", "reservationId is required"),
      { status: 400 },
    );
  }

  // Fetch reservation early (needed for signature verification and payment mode validation)
  const { getDb, restaurantReservations, eq } = await import("@repo/database");
  const reservation = await getDb().query.restaurantReservations.findFirst({
    where: eq(restaurantReservations.id, targetReservationId),
    with: { restaurant: true },
  });

  if (!reservation) {
    return NextResponse.json(
      errorResponse("NOT_FOUND", "Reservation not found"),
      { status: 404 },
    );
  }

  // EIP-712 SIGNATURE & DEADLINE VALIDATION
  try {
    validateDeadline(deadline);
  } catch (err) {
    if (err instanceof CheckoutError) {
      return NextResponse.json(
        errorResponse(err.code, err.message, err.details),
        { status: err.statusCode },
      );
    }
  }

  try {
    validateChainId(chainId);
  } catch (err) {
    if (err instanceof CheckoutError) {
      return NextResponse.json(
        errorResponse(err.code, err.message, err.details),
        { status: err.statusCode },
      );
    }
  }

  // Verify EIP-712 signature
  if (signature && walletAddress) {
    try {
      await verifySignature({
        signature,
        walletAddress,
        targetReservationId,
        reservation,
        paymentCurrency,
        signedAmount,
        deadline,
      });
    } catch (err) {
      if (err instanceof CheckoutError) {
        return NextResponse.json(
          errorResponse(err.code, err.message, err.details),
          { status: err.statusCode },
        );
      }
    }
  } else if (!signature) {
    return NextResponse.json(
      errorResponse("VALIDATION_ERROR", "EIP-712 signature is required"),
      { status: 400 },
    );
  }

  // Validate transaction hash format
  const { isValidTxHash } =
    await import("@repo/shared/utils/web3-verification");
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

  // Calculate expected crypto amount
  const depositUsdCents = reservation.depositAmount || 0;
  let expectedValue: bigint;
  if (paymentCurrency === "ETH") {
    expectedValue = await usdToCryptoBigInt(BigInt(depositUsdCents), "ETH");
  } else {
    const { parseUnits } = await import("viem");
    const dollars = Math.floor(depositUsdCents / 100);
    const centsRemainder = depositUsdCents % 100;
    expectedValue = parseUnits(
      `${dollars}.${String(centsRemainder).padStart(2, "0")}0000`,
      6,
    );
  }

  // Delegate to checkout service (handles replay guard, verification, DB update, notifications)
  const result = await checkoutService.processCheckout({
    txHash,
    reservationId: targetReservationId,
    paymentCurrency,
    expectedValue,
    frontendCallbackUrl,
    requestOrigin: new URL(req.url).origin,
  });

  if (!result.success) {
    return NextResponse.json(
      errorResponse(
        result.error.code,
        result.error.message,
        result.error.details,
      ),
      { status: result.error.statusCode },
    );
  }

  const responseData = successResponse(
    { txHash: result.data.txHash, confirmations: result.data.confirmations },
    { message: "Crypto payment verified successfully" },
  );

  return NextResponse.json(responseData);
}

export const POST = withUnifiedApiHandler(postHandler, {
  serviceName: "checkout-api",
  includeStackTrace: process.env.NODE_ENV !== "production",
});
