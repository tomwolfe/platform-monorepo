export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@tablestack/lib/auth";
import {
  IdempotencyService,
  IDEMPOTENCY_KEY_HEADER,
  getRedisClient,
  ServiceNamespace,
  withApiErrorHandler,
  Logger,
  formatApiError,
  formatApiSuccess,
  ReserveRequestSchema,
  validateRequest as validateZodRequest,
} from "@repo/shared";
import { reservationService } from "@tablestack/lib/reservation-service";
import { NotifyService } from "@tablestack/lib/notifications";
import { ConflictError } from "@repo/shared/errors";

export const runtime = "nodejs";

const redis = getRedisClient(ServiceNamespace.TS);
const logger = new Logger({ serviceName: "table-stack" });

async function postHandler(req: NextRequest) {
  // Auth validation
  const { error, status, context } = await validateRequest(req);
  if (error) {
    return NextResponse.json(formatApiError(new Error(error), "UNAUTHORIZED"), {
      status,
    });
  }

  // Idempotency check
  const idempotencyKey = req.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (!idempotencyKey) {
    return NextResponse.json(
      formatApiError(
        new Error("Idempotency key is required for mutative operations"),
        "VALIDATION_ERROR",
      ),
      { status: 400 },
    );
  }

  const idempotencyService = new IdempotencyService(redis);
  const isDuplicate = await idempotencyService.isDuplicate(
    idempotencyKey,
    "reserve_api",
  );
  if (isDuplicate) {
    return NextResponse.json(
      formatApiSuccess({ message: "Reservation already processed" }),
      {
        status: 200,
        headers: { "x-idempotency-duplicate": "true" },
      },
    );
  }

  // Zod validation
  const body = await req.json();
  const validation = validateZodRequest(ReserveRequestSchema, body);
  if (!validation.success) {
    return NextResponse.json(validation.error, { status: 400 });
  }

  const {
    restaurantId,
    restaurantName: discoveryName,
    restaurantEmail: discoveryEmail,
    tableId,
    combinedTableIds,
    guestName,
    guestEmail,
    partySize,
    startTime,
    metadata,
  } = validation.data;

  try {
    // Handle shadow restaurant discovery
    let targetRestaurantId = context!.restaurantId;
    if (
      context!.isInternal &&
      !targetRestaurantId &&
      discoveryName &&
      discoveryEmail
    ) {
      const restaurant = await reservationService.findOrCreateShadowRestaurant(
        discoveryName,
        discoveryEmail,
      );
      targetRestaurantId = restaurant.id;
    }

    if (!targetRestaurantId) {
      return NextResponse.json(
        formatApiError(
          new Error("Restaurant identifier missing"),
          "VALIDATION_ERROR",
        ),
        { status: 400 },
      );
    }

    if (restaurantId && restaurantId !== targetRestaurantId) {
      return NextResponse.json(
        formatApiError(
          new Error("Unauthorized access to this restaurant"),
          "FORBIDDEN",
        ),
        { status: 403 },
      );
    }

    // Create reservation via service
    const result = await reservationService.createReservation({
      restaurantId: targetRestaurantId,
      tableId,
      combinedTableIds,
      guestName,
      guestEmail: guestEmail!,
      partySize: partySize!,
      startTime: startTime!,
      metadata,
    });

    // Fetch restaurant details for notifications
    const restaurant =
      await reservationService.getRestaurant(targetRestaurantId);

    // Send notifications (side effects outside transaction)
    if (result.isShadow) {
      await NotifyService.sendClaimInvitation(
        restaurant.ownerEmail,
        restaurant.name,
        restaurant.claimToken!,
      );
      await NotifyService.notifyOwner(
        restaurant.ownerEmail,
        {
          guestName: result.reservation.guestName,
          partySize: result.reservation.partySize,
          startTime: result.reservation.startTime,
        },
        true,
      );

      return NextResponse.json(
        formatApiSuccess({
          message: "Shadow reservation created. Restaurant has been notified.",
          bookingId: result.reservation.id,
        }),
      );
    }

    // Send verification notification
    const verifyUrl = `${new URL(req.url).origin}/verify/${result.reservation.verificationToken}`;
    await NotifyService.sendNotification({
      to: result.reservation.guestEmail,
      subject: `Confirm your reservation at ${restaurant.name}`,
      html: `<h1>Hello ${result.reservation.guestName},</h1><p>Please confirm your reservation for ${result.reservation.partySize} people.</p><p><a href="${verifyUrl}">Click here to confirm</a></p>`,
    });

    return NextResponse.json(
      formatApiSuccess({
        message: "Reservation created. Please check your email to verify.",
        bookingId: result.reservation.id,
      }),
    );
  } catch (err) {
    if (err instanceof ConflictError) {
      return NextResponse.json(formatApiError(err, "CONFLICT"), {
        status: 409,
      });
    }
    throw err;
  }
}

export const POST = withApiErrorHandler(postHandler, {
  serviceName: "reserve-api",
  includeStackTrace: process.env.NODE_ENV !== "production",
});
