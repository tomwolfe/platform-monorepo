/**
 * API Route Example: Validated Reservation Endpoint
 *
 * Demonstrates how to use the new validation schemas and middleware
 * with Next.js API routes.
 *
 * @see Phase 1.3: API Validation & Standardization
 */

export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import {
  ReserveRequestSchema,
  formatValidationError,
  validateRequest,
} from '@repo/shared';
import {
  withApiErrorHandler,
  successResponse,
  validationErrorResponse,
  unauthorizedErrorResponse,
  notFoundErrorResponse,
} from '@repo/shared';
import { Logger } from '@repo/shared';
import { validateRequest as validateAuth } from '@tablestack/lib/auth';
import { getDb, restaurants, restaurantReservations } from '@repo/database';
import { eq } from '@repo/database';

// Initialize logger
const logger = new Logger({ serviceName: 'reserve-api-v2' });

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
export const POST = withApiErrorHandler(async (req: NextRequest) => {
  // Extract trace ID for logging
  const traceId = req.headers.get('x-trace-id') || undefined;
  const startTime = Date.now();

  logger.info('Reservation request received', { traceId });

  // Step 1: Authenticate request
  const authResult = await validateAuth(req);
  if (authResult.error) {
    logger.warn('Authentication failed', { traceId, error: authResult.error });
    return NextResponse.json(
      unauthorizedErrorResponse(authResult.error, { traceId }),
      { status: authResult.status || 401 }
    );
  }

  // Step 2: Parse and validate request body
  let body: unknown;
  try {
    body = await req.json();
  } catch (parseError) {
    logger.warn('Invalid JSON body', { traceId });
    return NextResponse.json(
      validationErrorResponse('Invalid JSON format', undefined, { traceId }),
      { status: 400 }
    );
  }

  const validation = validateRequest(ReserveRequestSchema, body);

  if (!validation.success) {
    logger.warn('Validation failed', {
      traceId,
      errors: validation.error.error.details,
    });
    return NextResponse.json(validation.error, { status: 400 });
  }

  const {
    restaurantId,
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
      validationErrorResponse('Restaurant ID is required', undefined, { traceId }),
      { status: 400 }
    );
  }

  // Step 4: Verify restaurant exists
  const restaurant = await getDb().query.restaurants.findFirst({
    where: eq(restaurants.id, targetRestaurantId),
  });

  if (!restaurant) {
    logger.warn('Restaurant not found', { traceId, restaurantId: targetRestaurantId });
    return NextResponse.json(
      notFoundErrorResponse('Restaurant', targetRestaurantId, { traceId }),
      { status: 404 }
    );
  }

  // Step 5: Check for conflicting reservations
  const reservationStart = new Date(reservationTime);
  const reservationEnd = new Date(reservationStart.getTime() + 90 * 60000);

  const conflictingReservation = await getDb().query.restaurantReservations.findFirst({
    where: eq(restaurantReservations.restaurantId, targetRestaurantId),
    columns: { id: true },
  });

  // Note: Add actual conflict detection logic here
  // This is a simplified example

  // Step 6: Create reservation (placeholder)
  const [newReservation] = await getDb().insert(restaurantReservations).values({
    restaurantId: targetRestaurantId,
    guestName,
    guestEmail,
    partySize,
    startTime: reservationStart,
    endTime: reservationEnd,
    status: 'pending',
    isVerified: false,
    specialRequests,
    metadata: occasion ? { occasion } : undefined,
  }).returning();

  const duration = Date.now() - startTime;
  logger.info('Reservation created successfully', {
    traceId,
    reservationId: newReservation.id,
    duration,
  });

  // Step 7: Return success response
  return NextResponse.json(
    successResponse(
      {
        bookingId: newReservation.id,
        message: 'Reservation created. Please check your email to verify.',
      },
      { traceId }
    )
  );
}, {
  serviceName: 'reserve-api-v2',
  includeStackTrace: process.env.NODE_ENV !== 'production',
});

// ============================================================================
// ALTERNATIVE: Using Validation Middleware
// ============================================================================

/**
 * Alternative implementation using validation middleware
 *
 * This shows how to use createValidationMiddleware for cleaner code
 */
/*
import { createValidationMiddleware } from '@repo/shared';

const validateReserveRequest = createValidationMiddleware(ReserveRequestSchema, {
  serviceName: 'reserve-api',
  stripUnknown: true,
});

export const POST = async (req: NextRequest) => {
  // Validate request
  const validation = await validateReserveRequest(req);

  if (!validation.valid) {
    return NextResponse.json(validation.error, { status: validation.status });
  }

  // validation.data is now typed as ReserveRequest
  const { guestName, guestEmail, partySize, startTime } = validation.data;

  // ... rest of handler logic
};
*/
