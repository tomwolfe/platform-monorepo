export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  IDEMPOTENCY_KEY_HEADER,
  withUnifiedApiHandler,
  formatApiError,
  formatApiSuccess,
  ReserveRequestSchema,
  validateRequest as validateZodRequest,
} from "@repo/shared";
import { validateRequest } from "@repo/shared/auth/gateway";
import { reservationOrchestrator } from "@tablestack/lib/services/reservation.orchestrator.service";
import { ConflictError, AppError } from "@repo/shared/errors";

export const runtime = "nodejs";

/**
 * POST /api/v1/reserve - Create a Restaurant Reservation
 *
 * This route delegates to ReservationOrchestratorService which handles:
 * - Idempotency checking
 * - Shadow restaurant discovery
 * - Reservation creation
 * - Email and cache notification dispatch
 *
 * @see apps/table-stack/src/lib/services/reservation.orchestrator.service.ts
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

  const idempotencyCheck =
    await reservationOrchestrator.checkIdempotency(idempotencyKey);
  if (idempotencyCheck.isDuplicate && idempotencyCheck.cachedResponse) {
    return idempotencyCheck.cachedResponse;
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
    const origin = new URL(req.url).origin;

    const result = await reservationOrchestrator.executeReservation(
      {
        restaurantId,
        restaurantName: discoveryName,
        restaurantEmail: discoveryEmail,
        tableId,
        combinedTableIds,
        guestName,
        guestEmail: guestEmail!,
        partySize: partySize!,
        startTime: startTime!,
        metadata,
      },
      {
        resourceId: context!.resourceId,
        isInternal: context!.isInternal,
      },
      idempotencyKey,
      origin,
    );

    return NextResponse.json(formatApiSuccess(result));
  } catch (err) {
    if (err instanceof ConflictError) {
      return NextResponse.json(formatApiError(err, "CONFLICT"), {
        status: 409,
      });
    }
    if (err instanceof AppError) {
      // Handle typed AppErrors from the error factory
      if (err.statusCode === 400) {
        return NextResponse.json(formatApiError(err, "VALIDATION_ERROR"), {
          status: 400,
        });
      }
      if (err.statusCode === 403) {
        return NextResponse.json(formatApiError(err, "FORBIDDEN"), {
          status: 403,
        });
      }
    }
    throw err;
  }
}

export const POST = withUnifiedApiHandler(
  async (req, ctx) => {
    const abortController = new AbortController();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error("Request timed out"));
      }, 8000);
    });

    const handlerPromise = postHandler(req);

    try {
      return await Promise.race([handlerPromise, timeoutPromise]);
    } catch (error) {
      if ((error as Error).message === "Request timed out") {
        return NextResponse.json(
          {
            error: "Gateway Timeout",
            message: "Request exceeded 8000ms timeout",
          },
          { status: 504 },
        );
      }
      throw error;
    }
  },
  {
    serviceName: "reserve-api",
    includeStackTrace: process.env.NODE_ENV !== "production",
  },
);
