export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { db } from "@repo/database";
import { restaurantReservations } from "@repo/database";
import { eq } from '@repo/database';
import { NotifyService } from '@/lib/notifications';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token');

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (!token || !uuidRegex.test(token)) {
    return NextResponse.json({ message: 'Missing or invalid token' }, { status: 400 });
  }

  try {
    const reservation = await db.query.restaurantReservations.findFirst({
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
    await db.update(restaurantReservations)
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
  } catch (error) {
    console.error('Verification Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
