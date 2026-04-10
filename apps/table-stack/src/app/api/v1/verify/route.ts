export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@repo/database";
import { restaurantReservations } from "@repo/database";
import { eq } from "@repo/database";
import { NotifyService } from "@tablestack/lib/notifications";
import { Logger } from "@repo/shared";
import {
  withUnifiedApiHandler,
  formatApiSuccess,
  formatApiError,
  validationErrorResponse,
  notFoundErrorResponse,
} from "@repo/shared";
import { rateLimit } from "@tablestack/lib/auth";

export const runtime = "nodejs";

const logger = new Logger({ serviceName: "verify-endpoint" });

// Rate limit: 5 attempts per IP per minute
const VERIFY_RATE_LIMIT = 5;
const VERIFY_RATE_WINDOW = 60; // seconds

async function getHandler(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!token || !uuidRegex.test(token)) {
    // Log failed verification attempt for audit
    logger.warn("Invalid verification token attempt", {
      token,
      ip: req.ip || req.headers.get("x-forwarded-for") || "unknown",
      userAgent: req.headers.get("user-agent"),
      timestamp: new Date().toISOString(),
    });

    return NextResponse.json(
      validationErrorResponse("Missing or invalid token"),
      { status: 400 },
    );
  }

  // Rate limiting check
  const clientIp = req.ip || req.headers.get("x-forwarded-for") || "unknown";
  const rateLimitKey = `verify:${clientIp}`;

  try {
    const { success } = await rateLimit(
      rateLimitKey,
      VERIFY_RATE_LIMIT,
      VERIFY_RATE_WINDOW,
    );

    if (!success) {
      logger.warn("Rate limit exceeded for verification endpoint", {
        ip: clientIp,
        timestamp: new Date().toISOString(),
      });

      return NextResponse.json(
        formatApiError(
          new Error("Too many verification attempts. Please try again later."),
          "RATE_LIMITED",
        ),
        { status: 429 },
      );
    }
  } catch (error) {
    logger.error("Rate limit check failed", { error });
    // Fail-open: allow verification to proceed if rate limiting fails
  }

  const reservation = await getDb().query.restaurantReservations.findFirst({
    where: eq(restaurantReservations.verificationToken, token),
    with: {
      restaurant: true,
    },
  });

  if (!reservation) {
    // Log failed verification attempt for audit
    logger.warn("Verification failed - token not found", {
      token,
      ip: clientIp,
      userAgent: req.headers.get("user-agent"),
      timestamp: new Date().toISOString(),
    });

    return NextResponse.json(notFoundErrorResponse("Reservation"), {
      status: 404,
    });
  }

  if (reservation.isVerified) {
    return NextResponse.json(
      formatApiSuccess({ message: "Reservation already verified" }),
    );
  }

  // Mark as verified and invalidate token (one-time use)
  await getDb()
    .update(restaurantReservations)
    .set({
      isVerified: true,
      status: "confirmed",
      verificationToken: "", // Invalidate token after use
    })
    .where(eq(restaurantReservations.id, reservation.id));

  // Notify owner
  if (reservation.restaurant && reservation.restaurant.ownerEmail) {
    await NotifyService.notifyOwner(reservation.restaurant.ownerEmail, {
      guestName: reservation.guestName,
      partySize: reservation.partySize,
      startTime: reservation.startTime,
    });
  }

  logger.info("Reservation verified successfully", {
    reservationId: reservation.id,
    ip: clientIp,
    timestamp: new Date().toISOString(),
  });

  return NextResponse.json(
    formatApiSuccess({ message: "Verification successful" }),
  );
}

export const GET = withUnifiedApiHandler(getHandler, { serviceName: "verify" });
