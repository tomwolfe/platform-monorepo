import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { restaurants, restaurantTables, reservations } from '@/db/schema';
import { and, eq, gte, or, sql } from 'drizzle-orm';
import { addMinutes, parseISO } from 'date-fns';
import { resend } from '@/lib/resend';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key');
  if (!apiKey) {
    return NextResponse.json({ message: 'Missing API key' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { restaurantId, tableId, guestName, guestEmail, partySize, startTime } = body;

    if (!restaurantId || !guestName || !guestEmail || !partySize || !startTime) {
      return NextResponse.json({ message: 'Missing required fields' }, { status: 400 });
    }

    // Verify API Key matches restaurant
    const restaurant = await db.query.restaurants.findFirst({
      where: and(eq(restaurants.id, restaurantId), eq(restaurants.apiKey, apiKey)),
    });

    if (!restaurant) {
      return NextResponse.json({ message: 'Invalid API key or restaurant ID' }, { status: 403 });
    }

    const start = parseISO(startTime);
    const end = addMinutes(start, 90);

    // Atomic check and insert
    // Note: Edge runtime support for full transactions might vary depending on the DB driver.
    // Neon HTTP driver doesn't support traditional transactions easily across multiple calls,
    // but we can do it in a single sql block if needed.
    // For now, let's use a simple check-then-insert.

    const conflict = await db.query.reservations.findFirst({
      where: and(
        eq(reservations.restaurantId, restaurantId),
        eq(reservations.tableId, tableId),
        or(
          eq(reservations.status, 'confirmed'),
          and(
            eq(reservations.isVerified, false),
            gte(reservations.createdAt, new Date(Date.now() - 20 * 60 * 1000))
          )
        ),
        sql`(${reservations.startTime}, ${reservations.endTime}) OVERLAPS (${start.toISOString()}, ${end.toISOString()})`
      ),
    });

    if (conflict) {
      return NextResponse.json({ message: 'Table is no longer available' }, { status: 409 });
    }

    const [newReservation] = await db.insert(reservations).values({
      restaurantId,
      tableId,
      guestName,
      guestEmail,
      partySize,
      startTime: start,
      endTime: end,
      isVerified: false,
    }).returning();

    // Send Verification Email
    const verifyUrl = `${new URL(req.url).origin}/verify/${newReservation.verificationToken}`;
    
    await resend.emails.send({
      from: 'TableStack <reservations@tablestack.io>', // You'll need a verified domain in Resend
      to: guestEmail,
      subject: `Confirm your reservation at ${restaurant.name}`,
      html: `
        <h1>Hello ${guestName},</h1>
        <p>Please confirm your reservation for ${partySize} people on ${start.toLocaleString()}.</p>
        <p><a href="${verifyUrl}">Click here to confirm your booking</a></p>
        <p>This link will expire in 20 minutes.</p>
      `,
    }).catch(err => console.error('Email send failed:', err));

    return NextResponse.json({
      message: 'Reservation created. Please check your email to verify.',
      bookingId: newReservation.id,
    });
  } catch (error) {
    console.error('Reservation Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
