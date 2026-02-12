import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { reservations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { NotifyService } from '@/lib/notify';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get('token');

  if (!token) {
    return NextResponse.json({ message: 'Missing token' }, { status: 400 });
  }

  try {
    const reservation = await db.query.reservations.findFirst({
      where: eq(reservations.verificationToken, token),
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
    await db.update(reservations)
      .set({ isVerified: true, status: 'confirmed' })
      .where(eq(reservations.id, reservation.id));

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
