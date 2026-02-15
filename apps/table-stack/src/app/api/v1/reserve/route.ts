export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { db } from "@repo/database";
import { restaurants, restaurantReservations, guestProfiles, restaurantTables } from "@repo/database";
import { and, eq, gte, lte, or, sql } from 'drizzle-orm';
import { addMinutes, parseISO } from 'date-fns';
import { NotifyService } from '@/lib/notify';
import { validateRequest } from '@/lib/auth';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
  const { error, status, context } = await validateRequest(req);
  if (error) return NextResponse.json({ message: error }, { status });

  try {
    const body = await req.json();
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
      metadata
    } = body;

    let targetRestaurantId = context!.restaurantId;

    // Handle Internal/Shadow discovery
    if (context!.isInternal && !targetRestaurantId && discoveryName && discoveryEmail) {
      // Find or create shadow restaurant
      let restaurant = await db.query.restaurants.findFirst({
        where: or(
          eq(restaurants.ownerEmail, discoveryEmail),
          eq(restaurants.name, discoveryName)
        ),
      });

      if (!restaurant) {
        const slug = discoveryName.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, '');
        const [newShadow] = await db.insert(restaurants).values({
          name: discoveryName,
          slug: `${slug}-${Math.random().toString(36).substring(2, 6)}`,
          ownerEmail: discoveryEmail,
          ownerId: 'shadow', // Placeholder for unclaimed
          apiKey: `ts_shadow_${Math.random().toString(36).substring(2, 10)}`,
          isShadow: true,
          isClaimed: false,
        }).returning();
        restaurant = newShadow;
      }
      targetRestaurantId = restaurant.id;
    }

    if (!targetRestaurantId) {
      return NextResponse.json({ message: 'Restaurant identifier missing' }, { status: 400 });
    }

    if (restaurantId && restaurantId !== targetRestaurantId) {
      return NextResponse.json({ message: 'Unauthorized access to this restaurant' }, { status: 403 });
    }

    if (!guestName || !guestEmail || !partySize || !startTime) {
      return NextResponse.json({ message: 'Missing required guest or time fields' }, { status: 400 });
    }

    // Verify Restaurant exists
    const restaurant = await db.query.restaurants.findFirst({
      where: eq(restaurants.id, targetRestaurantId),
    });

    if (!restaurant) {
      return NextResponse.json({ message: 'Restaurant not found' }, { status: 404 });
    }

    // Fetch guest profile for metadata propagation
    const existingProfile = await db.query.guestProfiles.findFirst({
      where: and(
        eq(guestProfiles.restaurantId, targetRestaurantId),
        eq(guestProfiles.email, guestEmail)
      )
    });

    // For shadow restaurants, we skip table conflict checks and just allow the booking
    const isShadow = restaurant.isShadow;

    const start = parseISO(startTime);
    const end = addMinutes(start, 90);

    let assignedTableId = tableId;

    if (!isShadow && !assignedTableId && (!combinedTableIds || !Array.isArray(combinedTableIds) || combinedTableIds.length === 0)) {
      // Auto-assign logic: find first vacant table matching partySize
      const availableTable = await db.query.restaurantTables.findFirst({
        where: and(
          eq(restaurantTables.restaurantId, targetRestaurantId),
          eq(restaurantTables.isActive, true),
          lte(restaurantTables.minCapacity, partySize),
          gte(restaurantTables.maxCapacity, partySize),
          sql`NOT EXISTS (
            SELECT 1 FROM ${restaurantReservations} r
            WHERE r.table_id = ${restaurantTables.id}
            AND r.status = 'confirmed'
            AND (${restaurantReservations.startTime}, ${restaurantReservations.endTime}) OVERLAPS (${start.toISOString()}, ${end.toISOString()})
          )`
        ),
      });

      if (!availableTable) {
        await NotifyService.notifyRejection(targetRestaurantId, {
          guestEmail,
          partySize,
          startTime,
          restaurantName: restaurant.name,
          visitCount: existingProfile?.visitCount || 0,
          preferences: existingProfile?.preferences || {}
        });
        return NextResponse.json({ message: 'No suitable tables available for this time and party size' }, { status: 409 });
      }
      assignedTableId = availableTable.id;
    }

    if (!isShadow) {
      const tablesToCheck = assignedTableId ? [assignedTableId] : combinedTableIds;

      // Enhanced Conflict Detection for both single and combined tables
      const conflict = await db.query.restaurantReservations.findFirst({
        where: and(
          eq(restaurantReservations.restaurantId, targetRestaurantId),
          or(
            eq(restaurantReservations.status, 'confirmed'),
            and(
              eq(restaurantReservations.isVerified, false),
              gte(restaurantReservations.createdAt, new Date(Date.now() - 15 * 60 * 1000))
            )
          ),
          // Use overlap logic
          sql`(${restaurantReservations.startTime}, ${restaurantReservations.endTime}) OVERLAPS (${start.toISOString()}, ${end.toISOString()})`,
          // Check if ANY of the tables we want are occupied
          or(
            // Check if it matches our single tableId
            assignedTableId ? eq(restaurantReservations.tableId, assignedTableId) : undefined,
            // OR if our tableId is part of someone else's combinedTables
            assignedTableId ? sql`${restaurantReservations.combinedTableIds} @> ${JSON.stringify([assignedTableId])}::jsonb` : undefined,
            // OR if our combinedTableIds contains a tableId that is someone's single tableId
            combinedTableIds ? sql`${restaurantReservations.tableId} = ANY(${sql.raw(`ARRAY['${tablesToCheck.join("','")}']::uuid[]`)})` : undefined,
            // OR if our combinedTableIds overlap with someone else's combinedTableIds
            combinedTableIds ? sql`${restaurantReservations.combinedTableIds} ?| ${sql.raw(`ARRAY['${tablesToCheck.join("','")}']`)}` : undefined
          )
        ),
      });

      if (conflict) {
        await NotifyService.notifyRejection(targetRestaurantId, {
          guestEmail,
          partySize,
          startTime,
          restaurantName: restaurant.name,
          visitCount: existingProfile?.visitCount || 0,
          preferences: existingProfile?.preferences || {}
        });
        return NextResponse.json({ message: 'One or more tables are no longer available' }, { status: 409 });
      }
    }

    const [newReservation] = await db.insert(restaurantReservations).values({
      restaurantId: targetRestaurantId,
      tableId: assignedTableId || null,
      combinedTableIds: combinedTableIds || null,
      guestName,
      guestEmail,
      partySize,
      startTime: start,
      endTime: end,
      isVerified: isShadow ? true : false,
      metadata: metadata || null,
    }).returning();

    // Upsert Guest Profile
    const [profile] = await db.insert(guestProfiles).values({
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
    }).returning();

    // High-Value Guest Hook: Trigger logistics if guest is frequent
    if ((profile.visitCount ?? 0) >= 5) {
      const { getIntentionEngineWebhookUrl, getInternalSystemKey } = await import('@/lib/env');
      const webhookUrl = getIntentionEngineWebhookUrl();
      const webhookSecret = getInternalSystemKey();
      
      if (webhookUrl) {
        const payload = JSON.stringify({
          event: 'high_value_guest_reservation',
          guest: {
            name: profile.name,
            email: profile.email,
            visitCount: profile.visitCount,
            defaultDeliveryAddress: profile.defaultDeliveryAddress
          },
          reservation: {
            id: newReservation.id,
            restaurantName: restaurant.name,
            startTime: newReservation.startTime,
            partySize: newReservation.partySize
          }
        });

        const { signPayload } = await import('@/lib/auth');
        const { signature, timestamp } = await signPayload(payload, webhookSecret);

        // Fire and forget webhook
        fetch(webhookUrl, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'x-signature': signature,
            'x-timestamp': timestamp.toString()
          },
          body: payload
        }).catch(err => console.error('Webhook failed:', err));
      }
    }

    if (isShadow) {
      // Send Claim Invitation to Owner
      await NotifyService.sendClaimInvitation(restaurant.ownerEmail, restaurant.name, restaurant.claimToken!);
      
      // Notify owner of the "Passive Booking"
      await NotifyService.notifyOwner(restaurant.ownerEmail, {
        guestName,
        partySize,
        startTime: start,
      }, true);

      return NextResponse.json({
        message: 'Shadow reservation created. Restaurant has been notified.',
        bookingId: newReservation.id,
      });
    }

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
