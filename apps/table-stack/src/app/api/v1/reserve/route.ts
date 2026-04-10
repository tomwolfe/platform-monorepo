export const dynamic = "force-dynamic";
import { NextRequest, NextResponse, after, revalidateTag } from "next/server";
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
import { withServerlessTimeout } from "@repo/shared/middleware/serverless-timeout";
import { withRetry } from "@repo/shared/middleware/retry-with-backoff";
import { reservationService } from "@tablestack/lib/reservation-service";
import { NotifyService } from "@tablestack/lib/notifications";
import { ConflictError } from "@repo/shared/errors";

export const runtime = "nodejs";

const redis = getRedisClient(ServiceNamespace.TS);
const logger = new Logger({ serviceName: "table-stack" });

/**
 * POST /api/v1/reserve - Create a Restaurant Reservation
 *
 * ## Outbox Pattern Implementation
 *
 * This route implements the **Outbox Pattern** to ensure reliable event delivery
 * when creating reservations. The outbox pattern decouples database transactions
 * from external side effects (email notifications) while maintaining consistency.
 *
 * ### How It Works
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Client
 *   participant API as POST /api/v1/reserve
 *   participant DB as Database
 *   participant Outbox as Outbox Table
 *   participant Relay as Outbox Relay (background)
 *   participant Email as Email Service (Resend)
 *
 *   Client->>API: POST /api/v1/reserve
 *   API->>DB: BEGIN TRANSACTION
 *   API->>DB: INSERT reservation
 *   API->>Outbox: INSERT outbox_event (email notification)
 *   API->>DB: COMMIT
 *   API-->>Client: 200 OK (reservation created)
 *   Note over API,Email: Decoupled via after()
 *   Relay->>Outbox: Poll for new events
 *   Outbox-->>Relay: Return pending events
 *   Relay->>Email: Send email notification
 *   Relay->>Outbox: Mark event as sent
 * ```
 *
 * ### Why Use the Outbox Pattern?
 *
 * 1. **Atomicity**: The reservation and the intent to send an email are committed
 *    in a single database transaction. Either both succeed or both fail.
 *
 * 2. **Reliability**: Even if the email service is temporarily unavailable, the
 *    outbox event persists in the database and will be retried by the background
 *    relay process.
 *
 * 3. **Performance**: The API response is returned immediately after the DB commit.
 *    Email sending happens asynchronously via `after()`, avoiding blocking the response.
 *
 * ### Implementation Details
 *
 * - **`after()` Hook**: Next.js `after()` is used to schedule background work that
 *   continues after the HTTP response is sent. This is serverless-safe and ensures
 *   notifications don't block the critical path.
 *
 * - **Idempotency**: The `IdempotencyService` prevents duplicate reservations from
 *   client retries. Keys are stored in Redis with a TTL.
 *
 * - **Shadow Restaurant Discovery**: If the restaurant doesn't exist in the database,
 *   a "shadow" restaurant is automatically created and the owner is notified via email
 *   to claim it.
 *
 * - **Serverless Timeout Protection**: The route is wrapped with `withServerlessTimeout(8000)`
 *   to ensure it completes before Vercel's 10-second hard limit.
 *
 * ### Request Schema
 *
 * ```json
 * {
 *   "restaurantId": "uuid",
 *   "restaurantName": "Restaurant Name",
 *   "restaurantEmail": "owner@example.com",
 *   "tableId": "uuid",
 *   "guestName": "John Doe",
 *   "guestEmail": "john@example.com",
 *   "partySize": 4,
 *   "startTime": "2024-01-15T19:00:00Z",
 *   "metadata": { "specialRequests": "Window seat preferred" }
 * }
 * ```
 *
 * ### Response Schema
 *
 * ```json
 * {
 *   "success": true,
 *   "data": {
 *     "message": "Reservation created. Please check your email to verify.",
 *     "bookingId": "uuid"
 *   }
 * }
 * ```
 *
 * @throws 400 - Validation error or missing idempotency key
 * @throws 401 - Unauthorized (invalid session)
 * @throws 403 - Forbidden (accessing another restaurant)
 * @throws 409 - Conflict (table already booked or duplicate request)
 * @throws 500 - Internal server error
 */
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
    const status = await idempotencyService.getStatus(
      idempotencyKey,
      "reserve_api",
    );
    if (status === "processing") {
      return NextResponse.json(
        formatApiError(
          new Error("Request still processing, please retry"),
          "CONFLICT",
        ),
        { status: 409 },
      );
    }
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

    // Create reservation via service (with retry for transient failures)
    const createReservationWithRetry = withRetry(
      (payload: Parameters<typeof reservationService.createReservation>[0]) =>
        reservationService.createReservation(payload),
      { maxAttempts: 2, baseDelay: 500 },
    );

    const result = await createReservationWithRetry({
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

    // Decouple external I/O from API critical path using after()
    after(async () => {
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
      } else {
        const verifyUrl = `${new URL(req.url).origin}/verify/${result.reservation.verificationToken}`;
        await NotifyService.sendNotification({
          to: result.reservation.guestEmail,
          subject: `Confirm your reservation at ${restaurant.name}`,
          html: `<h1>Hello ${result.reservation.guestName},</h1><p>Please confirm your reservation for ${result.reservation.partySize} people.</p><p><a href="${verifyUrl}">Click here to confirm</a></p>`,
        });
      }
    });

    // Mark idempotency key as processed
    await idempotencyService.markProcessed(idempotencyKey, "reserve_api");

    // T2.1: Invalidate availability cache for this restaurant
    // Use after() to avoid blocking the response
    after(async () => {
      try {
        // Redis cache invalidation
        const pattern = `availability:${targetRestaurantId}:*`;
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
          await redis.del(...keys);
          logger.info({
            message: `[T2.1] Invalidated ${keys.length} availability cache entries`,
            restaurantId: targetRestaurantId,
          });
        }

        // Next.js ISR cache invalidation
        revalidateTag("availability");
        revalidateTag(`restaurant:${targetRestaurantId}`);
      } catch (error) {
        logger.warn({
          message: "[T2.1] Failed to invalidate availability cache (non-fatal)",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return NextResponse.json(
      formatApiSuccess({
        message: result.isShadow
          ? "Shadow reservation created. Restaurant has been notified."
          : "Reservation created. Please check your email to verify.",
        bookingId: result.reservation.id,
      }),
    );
  } catch (err) {
    // Remove idempotency key on failure to allow retries
    await idempotencyService.removeKey(idempotencyKey, "reserve_api");
    if (err instanceof ConflictError) {
      return NextResponse.json(formatApiError(err, "CONFLICT"), {
        status: 409,
      });
    }
    throw err;
  }
}

export const POST = withServerlessTimeout(
  withApiErrorHandler(postHandler, {
    serviceName: "reserve-api",
    includeStackTrace: process.env.NODE_ENV !== "production",
  }),
  8000,
);
