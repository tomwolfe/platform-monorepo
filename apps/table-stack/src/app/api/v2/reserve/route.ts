/**
 * API Route Example: Validated Reservation Endpoint
 *
 * Demonstrates how to use the new validation schemas and middleware
 * with Next.js API routes.
 *
 * @see Phase 1.3: API Validation & Standardization
 */

export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { ReserveRequestSchema, validateRequest } from "@repo/shared";
import {
  withUnifiedApiHandler,
  successResponse,
  validationErrorResponse,
  unauthorizedErrorResponse,
  notFoundErrorResponse,
} from "@repo/shared";
import { Logger } from "@repo/shared";
import { validateRequest as validateAuth } from "@tablestack/lib/auth";
import {
  getDb,
  restaurants,
  restaurantReservations,
  restaurantTables,
  eq,
  and,
  or,
  gte,
  sql,
} from "@repo/database";
import { addMinutes, parseISO } from "date-fns";
import { ConflictError } from "@repo/shared/errors";

// Initialize logger
const logger = new Logger({ serviceName: "reserve-api-v2" });

/**
 * POST /api/v2/reserve
 *
 * Create a new reservation with full validation.
 *
 * Request Body:
 * - guestName: string (required, 1-255 chars)
 * - guestEmail: string (required, valid email)
 * - partySize: number (required, 1-50)
 * - startTime: string (required, ISO 8601)
 * - restaurantId: string (optional, UUID)
 * - specialRequests: string (optional, max 1000 chars)
 *
 * Responses:
 * - 200: Reservation created successfully
 * - 400: Validation error
 * - 401: Unauthorized
 * - 404: Restaurant not found
 * - 500: Internal server error
 */
export const POST = withUnifiedApiHandler(
  async (req: NextRequest) => {
    // Extract trace ID for logging
    const traceId = req.headers.get("x-trace-id") || undefined;
    const startTime = Date.now();

    logger.info("Reservation request received", { traceId });

    // Step 1: Authenticate request
    const authResult = await validateAuth(req);
    if (authResult.error) {
      logger.warn("Authentication failed", {
        traceId,
        error: authResult.error,
      });
      return NextResponse.json(
        unauthorizedErrorResponse(authResult.error, { traceId }),
        { status: authResult.status || 401 },
      );
    }

    // Step 2: Parse and validate request body
    let body: unknown;
    try {
      body = await req.json();
    } catch (parseError) {
      logger.warn("Invalid JSON body", { traceId });
      return NextResponse.json(
        validationErrorResponse("Invalid JSON format", undefined, { traceId }),
        { status: 400 },
      );
    }

    const validation = validateRequest(ReserveRequestSchema, body);

    if (!validation.success) {
      logger.warn("Validation failed", {
        traceId,
        errors: validation.error.error.details,
      });
      return NextResponse.json(validation.error, { status: 400 });
    }

    const {
      restaurantId,
      tableId,
      guestName,
      guestEmail,
      partySize,
      startTime: reservationTime,
      specialRequests,
      occasion,
    } = validation.data;

    // Step 3: Determine target restaurant
    const targetRestaurantId = restaurantId || authResult.context?.restaurantId;

    if (!targetRestaurantId) {
      return NextResponse.json(
        validationErrorResponse("Restaurant ID is required", undefined, {
          traceId,
        }),
        { status: 400 },
      );
    }

    // Step 4: Verify restaurant exists
    const restaurant = await getDb().query.restaurants.findFirst({
      where: eq(restaurants.id, targetRestaurantId),
    });

    if (!restaurant) {
      logger.warn("Restaurant not found", {
        traceId,
        restaurantId: targetRestaurantId,
      });
      return NextResponse.json(
        notFoundErrorResponse("Restaurant", targetRestaurantId, { traceId }),
        { status: 404 },
      );
    }

    // Step 5: Check for conflicting reservations and create reservation atomically
    const reservationStart = parseISO(reservationTime);
    const reservationEnd = addMinutes(reservationStart, 90);

    // Wrap conflict detection + insertion in an atomic transaction to prevent race conditions
    const { newReservation } = await getDb().transaction(async (tx) => {
      // Enforce strict DB-level timeout to prevent dangling locks if Lambda dies
      await tx.execute(sql`SET LOCAL statement_timeout = '7000'`);

      // Check for overlapping reservations with confirmed or pending status.
      // Use FOR UPDATE to lock matching rows and prevent concurrent double-booking.
      const conflictingReservation = await tx
        .select()
        .from(restaurantReservations)
        .where(
          and(
            eq(restaurantReservations.restaurantId, targetRestaurantId),
            eq(restaurantReservations.tableId, tableId),
            or(
              eq(restaurantReservations.status, "confirmed"),
              eq(restaurantReservations.status, "pending"),
              and(
                eq(restaurantReservations.isVerified, false),
                gte(
                  restaurantReservations.createdAt,
                  new Date(Date.now() - 15 * 60 * 1000),
                ),
              ),
            ),
            // Time overlap check using PostgreSQL OVERLAPS operator
            sql`(${restaurantReservations.startTime}, ${restaurantReservations.endTime}) OVERLAPS (${reservationStart.toISOString()}, ${reservationEnd.toISOString()})`,
          ),
        )
        .limit(1)
        .for("update")
        .then((rows) => rows[0]);

      if (conflictingReservation) {
        throw new ConflictError(
          "One or more tables are no longer available for this time slot",
        );
      }

      // Insert reservation within the same transaction
      const [insertedReservation] = await tx
        .insert(restaurantReservations)
        .values({
          restaurantId: targetRestaurantId,
          guestName,
          guestEmail,
          partySize,
          startTime: reservationStart,
          endTime: reservationEnd,
          status: "pending",
          isVerified: false,
          specialRequests,
          metadata: occasion ? { occasion } : undefined,
        })
        .returning();

      return { newReservation: insertedReservation };
    });

    const duration = Date.now() - startTime;
    logger.info("Reservation created successfully", {
      traceId,
      reservationId: newReservation.id,
      duration,
    });

    // Step 7: Return success response
    return NextResponse.json(
      successResponse(
        {
          bookingId: newReservation.id,
          message: "Reservation created. Please check your email to verify.",
        },
        { traceId },
      ),
    );
  },
  {
    serviceName: "reserve-api-v2",
    includeStackTrace: process.env.NODE_ENV !== "production",
  },
);
