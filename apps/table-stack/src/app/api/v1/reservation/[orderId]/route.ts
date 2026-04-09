/**
 * GET /api/v1/reservation/[orderId]
 *
 * Returns the current status of a reservation by ID.
 * Used by the pending verification page to poll for payment confirmation.
 *
 * @see Phase 2.1: Pending Verification State UI
 */

import { NextRequest, NextResponse } from "next/server";
import {
  withApiErrorHandler,
  getLogger,
  createApiError,
  NotFoundError,
} from "@repo/shared";
import { db } from "@repo/database";
import { eq } from "drizzle-orm";
import { restaurantReservations } from "@repo/database/schema";

async function getHandler(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params;
  const logger = getLogger({
    serviceName: "table-stack",
    operation: "get-reservation-status",
  });

  if (!orderId) {
    throw createApiError("ORDER_ID_REQUIRED", "Order ID is required", 400);
  }

  logger.info("Fetching reservation status", { orderId });

  // Fetch reservation from database
  const [reservation] = await db
    .select({
      id: restaurantReservations.id,
      status: restaurantReservations.status,
      isVerified: restaurantReservations.isVerified,
      depositAmount: restaurantReservations.depositAmount,
      metadata: restaurantReservations.metadata,
      createdAt: restaurantReservations.createdAt,
      updatedAt: restaurantReservations.updatedAt,
    })
    .from(restaurantReservations)
    .where(eq(restaurantReservations.id, orderId))
    .limit(1);

  if (!reservation) {
    throw new NotFoundError("Reservation", orderId);
  }

  // Extract payment tx hash from metadata if present
  const paymentTxHash = (reservation.metadata as Record<string, unknown> | null)
    ?.paymentTxHash as string | undefined;

  // Convert deposit amount from cents to dollars
  const depositAmount = reservation.depositAmount
    ? reservation.depositAmount / 100
    : undefined;

  return NextResponse.json({
    id: reservation.id,
    status: reservation.status || "pending",
    isVerified: reservation.isVerified || false,
    paymentTxHash,
    depositAmount,
    createdAt: reservation.createdAt?.toISOString(),
    updatedAt: reservation.updatedAt?.toISOString(),
  });
}

export const GET = withApiErrorHandler(getHandler, {
  serviceName: "table-stack-reservation-status",
});
