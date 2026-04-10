export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@repo/database";
import { restaurantReservations } from "@repo/database";
import { eq } from "@repo/database";
import { NotifyService } from "@tablestack/lib/notifications";
import {
  withUnifiedApiHandler,
  formatApiSuccess,
  validationErrorResponse,
  notFoundErrorResponse,
} from "@repo/shared";

export const runtime = "nodejs";

async function getHandler(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!token || !uuidRegex.test(token)) {
    return NextResponse.json(
      validationErrorResponse("Missing or invalid token"),
      { status: 400 },
    );
  }

  const reservation = await getDb().query.restaurantReservations.findFirst({
    where: eq(restaurantReservations.verificationToken, token),
    with: {
      restaurant: true,
    },
  });

  if (!reservation) {
    return NextResponse.json(notFoundErrorResponse("Reservation"), {
      status: 404,
    });
  }

  if (reservation.isVerified) {
    return NextResponse.json(
      formatApiSuccess({ message: "Reservation already verified" }),
    );
  }

  // Mark as verified
  await getDb()
    .update(restaurantReservations)
    .set({ isVerified: true, status: "confirmed" })
    .where(eq(restaurantReservations.id, reservation.id));

  // Notify owner
  if (reservation.restaurant && reservation.restaurant.ownerEmail) {
    await NotifyService.notifyOwner(reservation.restaurant.ownerEmail, {
      guestName: reservation.guestName,
      partySize: reservation.partySize,
      startTime: reservation.startTime,
    });
  }

  return NextResponse.json(
    formatApiSuccess({ message: "Verification successful" }),
  );
}

export const GET = withUnifiedApiHandler(getHandler, { serviceName: "verify" });
