export const dynamic = 'force-dynamic';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from "@repo/database";
import { restaurants, restaurantReservations, guestProfiles, restaurantTables } from "@repo/database";
import { and, eq, gte, lte, or, sql } from '@repo/database';
import { addMinutes, parseISO } from 'date-fns';
import { NotifyService } from '@tablestack/lib/notifications';
import { validateRequest } from '@tablestack/lib/auth';
import { IdempotencyService, IDEMPOTENCY_KEY_HEADER, getRedisClient, ServiceNamespace, withApiErrorHandler } from '@repo/shared';
import { withNervousSystemTracing, injectTracingHeaders } from '@repo/shared/tracing';
import { formatApiError, formatApiSuccess, type EngineErrorCode, ReserveRequestSchema, validateRequest as validateZodRequest } from '@repo/shared';
import { ConflictError } from '@repo/shared/errors';

export const runtime = 'nodejs';

const redis = getRedisClient(ServiceNamespace.TS);

async function postHandler(req: NextRequest) {
  const { error, status, context } = await validateRequest(req);
  if (error) return NextResponse.json(formatApiError(new Error(error), 'UNAUTHORIZED'), { status });

  const idempotencyKey = req.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (idempotencyKey) {
    const idempotencyService = new IdempotencyService(redis);
    const isDuplicate = await idempotencyService.isDuplicate(idempotencyKey, 'reserve_api');
    if (isDuplicate) {
      return NextResponse.json(formatApiSuccess({ message: 'Reservation already processed' }, { traceId: req.headers.get('x-trace-id') || undefined }), { status: 200, headers: { 'x-idempotency-duplicate': 'true' } });
    }
  }

  let targetRestaurantId: string | undefined;
  let restaurant: any;
  let existingProfile: any;
  let guestEmail: string | undefined;
  let startTime: string | undefined;
  let partySize: number | undefined;

  const body = await req.json();

  // Validate request body with Zod schema
  const validation = validateZodRequest(ReserveRequestSchema, body);
  if (!validation.success) {
    return NextResponse.json(validation.error, { status: 400 });
  }

  const {
    restaurantId,
    restaurantName: discoveryName,
    restaurantEmail: discoveryEmail,
    tableId,
    combinedTableIds,
    guestName,
    guestEmail: bodyGuestEmail,
    partySize: bodyPartySize,
    startTime: bodyStartTime,
    metadata,
    specialRequests,
    occasion
  } = validation.data;

  guestEmail = bodyGuestEmail;
  startTime = bodyStartTime;
  partySize = bodyPartySize;

  targetRestaurantId = context!.restaurantId;

  // Handle Internal/Shadow discovery
  if (context!.isInternal && !targetRestaurantId && discoveryName && discoveryEmail) {
    // Find or create shadow restaurant
    restaurant = await getDb().query.restaurants.findFirst({
      where: or(
        eq(restaurants.ownerEmail, discoveryEmail),
        eq(restaurants.name, discoveryName)
      ),
    });

    if (!restaurant) {
      const slug = discoveryName.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, '');
      const [newShadow] = await getDb().insert(restaurants).values({
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
    return NextResponse.json(formatApiError(new Error('Restaurant identifier missing'), 'VALIDATION_ERROR'), { status: 400 });
  }

  if (restaurantId && restaurantId !== targetRestaurantId) {
    return NextResponse.json(formatApiError(new Error('Unauthorized access to this restaurant'), 'FORBIDDEN'), { status: 403 });
  }

  if (!guestName || !guestEmail || !partySize || !startTime) {
    return NextResponse.json(formatApiError(new Error('Missing required guest or time fields'), 'VALIDATION_ERROR'), { status: 400 });
  }

  // Verify Restaurant exists
  restaurant = await getDb().query.restaurants.findFirst({
    where: eq(restaurants.id, targetRestaurantId),
  });

  if (!restaurant) {
    return NextResponse.json(formatApiError(new Error('Restaurant not found'), 'NOT_FOUND'), { status: 404 });
  }

  // Fetch guest profile for metadata propagation
  existingProfile = await getDb().query.guestProfiles.findFirst({
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

  // ============================================================================
  // ATOMIC TRANSACTION: Wrap all operations in a single transaction
  // This prevents race conditions by locking rows during the transaction
  // ============================================================================
  const result = await getDb().transaction(async (tx: any) => {
    // Auto-assign logic with row-level locking (FOR UPDATE SKIP LOCKED)
    if (!isShadow && !assignedTableId && (!combinedTableIds || !Array.isArray(combinedTableIds) || combinedTableIds.length === 0)) {
      // CRITICAL FIX: Use raw SQL with FOR UPDATE SKIP LOCKED to prevent race conditions
      // Drizzle ORM doesn't support FOR UPDATE directly, so we use raw SQL
      const availableTable = await tx.execute(sql`
        SELECT id, restaurant_id, "minCapacity", "maxCapacity", "isActive"
        FROM ${restaurantTables}
        WHERE ${restaurantTables.restaurantId} = ${targetRestaurantId}
          AND ${restaurantTables.isActive} = true
          AND ${restaurantTables.minCapacity} <= ${partySize}
          AND ${restaurantTables.maxCapacity} >= ${partySize}
          AND NOT EXISTS (
            SELECT 1 FROM ${restaurantReservations} r
            WHERE r.table_id = ${restaurantTables.id}
              AND r.status = 'confirmed'
              AND (r.start_time, r.end_time) OVERLAPS (${start.toISOString()}, ${end.toISOString()})
          )
        ORDER BY ${restaurantTables.id}
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);

      if (!availableTable || availableTable.length === 0) {
        // Rollback will happen automatically
        throw new ConflictError('No suitable tables available for this time and party size');
      }
      assignedTableId = availableTable[0].id;
    }

    if (!isShadow) {
      const tablesToCheck = assignedTableId ? [assignedTableId] : combinedTableIds;

      // Enhanced Conflict Detection for both single and combined tables
      // Check for conflicts within the same transaction (isolated view)
      const conflict = await tx.query.restaurantReservations.findFirst({
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
          sql`(${restaurantReservations.startTime}, ${restaurantReservations.endTime}) OVERLAPS (${sql.placeholder(start.toISOString())}, ${sql.placeholder(end.toISOString())})`,
          // Check if ANY of the tables we want are occupied
          or(
            // Check if it matches our single tableId
            assignedTableId ? eq(restaurantReservations.tableId, assignedTableId) : undefined,
            // OR if our tableId is part of someone else's combinedTables
            assignedTableId ? sql`${restaurantReservations.combinedTableIds} @> ${sql.placeholder(JSON.stringify([assignedTableId]))}::jsonb` : undefined,
            // OR if our combinedTableIds contains a tableId that is someone's single tableId
            combinedTableIds ? sql`${restaurantReservations.tableId} = ANY(${sql.raw(`ARRAY['${tablesToCheck.join("','")}']::uuid[]`)})` : undefined,
            // OR if our combinedTableIds overlap with someone else's combinedTableIds
            combinedTableIds ? sql`${restaurantReservations.combinedTableIds} ?| ${sql.raw(`ARRAY['${tablesToCheck.join("','")}']`)}` : undefined
          )
        ),
      });

      if (conflict) {
        // Rollback will happen automatically
        throw new ConflictError('One or more tables are no longer available');
      }
    }

    // Insert reservation (within transaction)
    const [newReservation] = await tx.insert(restaurantReservations).values({
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

    // Upsert Guest Profile (within same transaction)
    const [profile] = await tx.insert(guestProfiles).values({
      restaurantId: targetRestaurantId,
      email: guestEmail,
      name: guestName,
      visitCount: 1,
    }).onConflictDoUpdate({
      target: [guestProfiles.restaurantId, guestProfiles.email],
      set: {
        name: guestName, // Update name if it changed
        visitCount: sql.raw(`${guestProfiles.visitCount} + 1`),
        updatedAt: new Date(),
      }
    }).returning();

    return { newReservation, profile };
  });

  const { newReservation, profile } = result;

  // High-Value Guest Hook: Trigger logistics if guest is frequent
  // Note: This is outside the transaction since it's a side effect (publishing to Redis)
  if ((profile.visitCount ?? 0) >= 5) {
    const { RealtimeService } = await import('@repo/shared');
    const mcpProtocol = await import('@repo/mcp-protocol');

    // Extract trace ID from request headers if available
    const traceId = req.headers.get('x-trace-id') || undefined;

    // Phase 2: Use structured SystemEvent schema
    const event = mcpProtocol.createTypedSystemEvent(
      'HighValueGuestReservation',
      {
        guest: {
          name: profile.name,
          email: profile.email,
          visitCount: profile.visitCount,
          defaultDeliveryAddress: profile.defaultDeliveryAddress,
          preferences: profile.preferences || {},
        },
        reservation: {
          id: newReservation.id,
          restaurantName: restaurant.name,
          startTime: newReservation.startTime.toISOString(),
          partySize: newReservation.partySize,
        },
      },
      'table-stack',
      { traceId }
    );

    // Publish to Nervous System mesh with trace ID propagation (Phase 5)
    await RealtimeService.publishNervousSystemEvent(
      event.type,
      event.payload,
      event.traceId
    ).catch(err => console.error('Nervous System Event failed:', err));
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

    return NextResponse.json(formatApiSuccess({
      message: 'Shadow reservation created. Restaurant has been notified.',
      bookingId: newReservation.id,
    }));
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

  return NextResponse.json(formatApiSuccess({
    message: 'Reservation created. Please check your email to verify.',
    bookingId: newReservation.id,
  }));
}

export const POST = withApiErrorHandler(postHandler, {
  serviceName: 'reserve-api',
  includeStackTrace: process.env.NODE_ENV !== 'production',
});
