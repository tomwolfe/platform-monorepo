import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { restaurants, reservations, guestProfiles } from '@/db/schema';
import { and, eq, gte, or, sql } from 'drizzle-orm';
import { addMinutes, parseISO } from 'date-fns';
import { NotifyService } from '@/lib/notify';
import { validateRequest } from '@/lib/auth';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
  const { error, status, context } = await validateRequest(req);
  if (error) return NextResponse.json({ message: error }, { status });

  try {
    const body = await req.json();
    const { restaurantId, tableId, combinedTableIds, guestName, guestEmail, partySize, startTime } = body;

    const targetRestaurantId = context!.restaurantId;

    if (restaurantId && restaurantId !== targetRestaurantId) {
      return NextResponse.json({ message: 'Unauthorized access to this restaurant' }, { status: 403 });
    }

    if (!guestName || !guestEmail || !partySize || !startTime) {
      return NextResponse.json({ message: 'Missing required guest or time fields' }, { status: 400 });
    }

    if (!tableId && (!combinedTableIds || !Array.isArray(combinedTableIds) || combinedTableIds.length === 0)) {
      return NextResponse.json({ message: 'Missing table selection' }, { status: 400 });
    }

    // Verify Restaurant exists
    const restaurant = await db.query.restaurants.findFirst({
      where: eq(restaurants.id, targetRestaurantId),
    });

    if (!restaurant) {
      return NextResponse.json({ message: 'Restaurant not found' }, { status: 404 });
    }

    const start = parseISO(startTime);
    const end = addMinutes(start, 90);

    const tablesToCheck = tableId ? [tableId] : combinedTableIds;

    // Enhanced Conflict Detection for both single and combined tables
    const conflict = await db.query.reservations.findFirst({
      where: and(
        eq(reservations.restaurantId, targetRestaurantId),
        or(
          eq(reservations.status, 'confirmed'),
          and(
            eq(reservations.isVerified, false),
            gte(reservations.createdAt, new Date(Date.now() - 15 * 60 * 1000))
          )
        ),
        // Use overlap logic
        sql`(${reservations.startTime}, ${reservations.endTime}) OVERLAPS (${start.toISOString()}, ${end.toISOString()})`,
        // Check if ANY of the tables we want are occupied
        or(
          // Check if it matches our single tableId
          tableId ? eq(reservations.tableId, tableId) : undefined,
          // OR if our tableId is part of someone else's combinedTables
          tableId ? sql`${reservations.combinedTableIds} @> ${JSON.stringify([tableId])}::jsonb` : undefined,
          // OR if our combinedTableIds contains a tableId that is someone's single tableId
          combinedTableIds ? sql`${reservations.tableId} = ANY(${sql.raw(`ARRAY['${tablesToCheck.join("','")}']::uuid[]`)})` : undefined,
          // OR if our combinedTableIds overlap with someone else's combinedTableIds
          combinedTableIds ? sql`${reservations.combinedTableIds} ?| ${sql.raw(`ARRAY['${tablesToCheck.join("','")}']`)}` : undefined
        )
      ),
    });

    if (conflict) {
      return NextResponse.json({ message: 'One or more tables are no longer available' }, { status: 409 });
    }

    const [newReservation] = await db.insert(reservations).values({
      restaurantId: targetRestaurantId,
      tableId: tableId || null,
      combinedTableIds: combinedTableIds || null,
      guestName,
      guestEmail,
      partySize,
      startTime: start,
      endTime: end,
      isVerified: false,
    }).returning();

    // Upsert Guest Profile
    await db.insert(guestProfiles).values({
      restaurantId: targetRestaurantId,
      email: guestEmail,
      name: guestName,
      visitCount: 1,
    }).onConflictDoUpdate({
      target: [guestProfiles.restaurantId, guestProfiles.email],
      set: {
        name: guestName, // Update name if it changed
        visitCount: sql`${guestProfiles.visitCount} + 1`,
        updatedAt: new Date(),
      }
    });

    // Send Verification Notification
    const verifyUrl = `${new URL(req.url).origin}/verify/${newReservation.verificationToken}`;
    
    await NotifyService.sendNotification({
      to: guestEmail,
      subject: `Confirm your reservation at ${restaurant.name}`,
      html: `
        <h1>Hello ${guestName},</h1>
        <p>Please confirm your reservation for ${partySize} people on ${start.toLocaleString()}.</p>
        <p><a href="${verifyUrl}">Click here to confirm your booking</a></p>
        <p>This link will expire in 15 minutes.</p>
      `,
    });

    return NextResponse.json({
      message: 'Reservation created. Please check your email to verify.',
      bookingId: newReservation.id,
    });
  } catch (error) {
    console.error('Reservation Error:', error);
    return NextResponse.json({ message: 'Internal server error' }, { status: 500 });
  }
}
