export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from "@repo/database";
import { restaurantReservations } from "@repo/database";
import { eq } from '@repo/database';
import { NotifyService } from '@tablestack/lib/notifications';
import { withApiErrorHandler } from '@repo/shared';

export const runtime = 'nodejs';

async function getHandler(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token');

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!token || !uuidRegex.test(token)) {
    return NextResponse.json({ message: 'Missing or invalid token' }, { status: 400 });
  }

  const reservation = await getDb().query.restaurantReservations.findFirst({
    where: eq(restaurantReservations.verificationToken, token),
    with: {
      restaurant: true,
    },
  });

  if (!reservation) {
    return NextResponse.json({ message: 'Invalid token' }, { status: 404 });
  }

  if (reservation.isVerified) {
    return NextResponse.json({ message: 'Reservation already verified' });
  }

  // Mark as verified
  await getDb().update(restaurantReservations)
    .set({ isVerified: true, status: 'confirmed' })
    .where(eq(restaurantReservations.id, reservation.id));

  // Notify owner
  if (reservation.restaurant && reservation.restaurant.ownerEmail) {
    await NotifyService.notifyOwner(reservation.restaurant.ownerEmail, {
      guestName: reservation.guestName,
      partySize: reservation.partySize,
      startTime: reservation.startTime,
    });
  }

  return NextResponse.json({ message: 'Verification successful' });
}

export const GET = withApiErrorHandler(getHandler, 'EXECUTION_FAILED');
