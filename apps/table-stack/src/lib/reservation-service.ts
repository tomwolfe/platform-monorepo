/**
 * Reservation Service
 *
 * Core business logic for reservation management.
 * Extracted from API routes to improve testability and reusability.
 */

import { getDb } from "@repo/database";
import {
  restaurants,
  restaurantReservations,
  guestProfiles,
  restaurantTables,
} from "@repo/database";
import { and, eq, gte, or, sql } from "@repo/database";
import { addMinutes, parseISO } from "date-fns";
import { ConflictError, AppError } from "@repo/shared/errors";
import crypto from "crypto";

export interface CreateReservationInput {
  restaurantId: string;
  tableId?: string;
  combinedTableIds?: string[];
  guestName: string;
  guestEmail: string;
  partySize: number;
  startTime: string;
  metadata?: Record<string, unknown>;
  specialRequests?: string;
  occasion?: string;
}

export interface CreateReservationResult {
  reservation: typeof restaurantReservations.$inferSelect;
  profile: typeof guestProfiles.$inferSelect;
  isShadow: boolean;
}

export interface AvailabilityCheck {
  restaurantId: string;
  date: string;
  partySize: number;
}

export class ReservationService {
  /**
   * Check table availability for a given date and party size
   */
  async checkAvailability({
    restaurantId,
    date,
    partySize,
  }: AvailabilityCheck) {
    const db = getDb();
    const start = parseISO(date);
    const end = addMinutes(start, 90);

    // Fetch occupied tables during this time slot
    const occupiedReservations = await db
      .select({
        tableId: restaurantReservations.tableId,
        combinedTableIds: restaurantReservations.combinedTableIds,
      })
      .from(restaurantReservations)
      .where(
        and(
          eq(restaurantReservations.restaurantId, restaurantId),
          or(
            eq(restaurantReservations.status, "confirmed"),
            and(
              eq(restaurantReservations.isVerified, false),
              gte(
                restaurantReservations.startTime,
                new Date(Date.now() - 15 * 60 * 1000),
              ),
            ),
          ),
          sql`(${restaurantReservations.startTime}, ${restaurantReservations.endTime}) OVERLAPS (${start.toISOString()}, ${end.toISOString()})`,
        ),
      );

    // Fetch all active tables
    const allTables = await db
      .select({
        id: restaurantTables.id,
        tableNumber: restaurantTables.tableNumber,
        maxCapacity: restaurantTables.maxCapacity,
        minCapacity: restaurantTables.minCapacity,
        tableType: restaurantTables.tableType,
        xPos: restaurantTables.xPos,
        yPos: restaurantTables.yPos,
      })
      .from(restaurantTables)
      .where(
        and(
          eq(restaurantTables.restaurantId, restaurantId),
          eq(restaurantTables.isActive, true),
        ),
      );

    // Filter out occupied tables
    const occupiedTableIds = new Set<string>();
    const occupiedCombinedTableIds = new Set<string>();

    for (const res of occupiedReservations) {
      if (res.tableId) {
        occupiedTableIds.add(res.tableId);
      }
      if (res.combinedTableIds && Array.isArray(res.combinedTableIds)) {
        for (const id of res.combinedTableIds as string[]) {
          occupiedCombinedTableIds.add(id);
        }
      }
    }

    const availableTables = allTables.filter(
      (table) =>
        !occupiedTableIds.has(table.id) &&
        !occupiedCombinedTableIds.has(table.id) &&
        table.maxCapacity >= partySize,
    );

    return {
      availableTables,
      occupiedCount: occupiedReservations.length,
      totalCount: allTables.length,
    };
  }

  /**
   * Create a new reservation with atomic transaction handling
   */
  async createReservation(
    input: CreateReservationInput,
  ): Promise<CreateReservationResult> {
    const db = getDb();
    const {
      restaurantId,
      tableId,
      combinedTableIds,
      guestName,
      guestEmail,
      partySize,
      startTime,
      metadata,
    } = input;

    // Verify restaurant exists and get details
    const restaurant = await db.query.restaurants.findFirst({
      where: eq(restaurants.id, restaurantId),
    });

    if (!restaurant) {
      throw new AppError("NOT_FOUND", "Restaurant not found", 404, {
        restaurantId,
      });
    }

    const isShadow = restaurant.isShadow;
    const start = parseISO(startTime);
    const end = addMinutes(start, 90);
    let assignedTableId = tableId;

    // Execute atomic transaction
    const result = await db.transaction(async (tx) => {
      // Auto-assign logic with row-level locking (FOR UPDATE SKIP LOCKED)
      if (
        !isShadow &&
        !assignedTableId &&
        (!combinedTableIds ||
          !Array.isArray(combinedTableIds) ||
          combinedTableIds.length === 0)
      ) {
        const availableTable = await tx.execute(sql`
          SELECT id, restaurant_id, "minCapacity", "maxCapacity", "isActive"
          FROM ${restaurantTables}
          WHERE ${restaurantTables.restaurantId} = ${restaurantId}
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
          throw new ConflictError(
            "No suitable tables available for this time and party size",
          );
        }

        const lockedTableId = availableTable[0]?.id;
        if (!lockedTableId) {
          throw new ConflictError("No tables locked successfully");
        }
        assignedTableId = lockedTableId;
      }

      // Conflict detection for non-shadow restaurants
      if (!isShadow) {
        const tablesToCheck = assignedTableId
          ? [assignedTableId]
          : combinedTableIds || [];

        const conflict = await tx.query.restaurantReservations.findFirst({
          where: and(
            eq(restaurantReservations.restaurantId, restaurantId),
            or(
              eq(restaurantReservations.status, "confirmed"),
              and(
                eq(restaurantReservations.isVerified, false),
                gte(
                  restaurantReservations.startTime,
                  new Date(Date.now() - 15 * 60 * 1000),
                ),
              ),
            ),
            sql`(${restaurantReservations.startTime}, ${restaurantReservations.endTime}) OVERLAPS (${start.toISOString()}, ${end.toISOString()})`,
            or(
              assignedTableId
                ? eq(restaurantReservations.tableId, assignedTableId)
                : undefined,
              assignedTableId
                ? sql`${restaurantReservations.combinedTableIds} @> ${JSON.stringify([assignedTableId])}::jsonb`
                : undefined,
              combinedTableIds
                ? sql`${restaurantReservations.tableId} = ANY(${tablesToCheck}::uuid[])`
                : undefined,
              combinedTableIds
                ? sql`${restaurantReservations.combinedTableIds} && ${tablesToCheck}::uuid[]`
                : undefined,
            ),
          ),
        });

        if (conflict) {
          throw new ConflictError("One or more tables are no longer available");
        }
      }

      // Insert reservation
      const [newReservation] = await tx
        .insert(restaurantReservations)
        .values({
          restaurantId,
          tableId: assignedTableId || null,
          combinedTableIds: combinedTableIds || null,
          guestName,
          guestEmail,
          partySize,
          startTime: start,
          endTime: end,
          isVerified: isShadow ? true : false,
          metadata: metadata || null,
        })
        .returning();

      // Upsert guest profile
      const [profile] = await tx
        .insert(guestProfiles)
        .values({
          restaurantId,
          email: guestEmail,
          name: guestName,
          visitCount: 1,
        })
        .onConflictDoUpdate({
          target: [guestProfiles.restaurantId, guestProfiles.email],
          set: {
            name: guestName,
            visitCount: sql.raw(`${guestProfiles.visitCount} + 1`),
            updatedAt: new Date(),
          },
        })
        .returning();

      return { newReservation, profile };
    });

    return {
      reservation: result.newReservation,
      profile: result.profile,
      isShadow,
    };
  }

  /**
   * Cancel a reservation
   */
  async cancelReservation(reservationId: string): Promise<void> {
    const db = getDb();

    const reservation = await db.query.restaurantReservations.findFirst({
      where: eq(restaurantReservations.id, reservationId),
    });

    if (!reservation) {
      throw new AppError("NOT_FOUND", "Reservation not found", 404, {
        reservationId,
      });
    }

    if (reservation.status === "cancelled") {
      throw new AppError(
        "ALREADY_CANCELLED",
        "Reservation already cancelled",
        400,
        {
          reservationId,
        },
      );
    }

    await db
      .update(restaurantReservations)
      .set({
        status: "cancelled",
        endTime: new Date(),
      })
      .where(eq(restaurantReservations.id, reservationId));
  }

  /**
   * Get restaurant details by ID
   */
  async getRestaurant(
    restaurantId: string,
  ): Promise<typeof restaurants.$inferSelect> {
    const db = getDb();

    const restaurant = await db.query.restaurants.findFirst({
      where: eq(restaurants.id, restaurantId),
    });

    if (!restaurant) {
      throw new AppError("NOT_FOUND", "Restaurant not found", 404, {
        restaurantId,
      });
    }

    return restaurant;
  }

  /**
   * Find or create shadow restaurant for discovery flow
   */
  async findOrCreateShadowRestaurant(
    discoveryName: string,
    discoveryEmail: string,
  ): Promise<typeof restaurants.$inferSelect> {
    const db = getDb();

    let restaurant = await db.query.restaurants.findFirst({
      where: or(
        eq(restaurants.ownerEmail, discoveryEmail),
        eq(restaurants.name, discoveryName),
      ),
    });

    if (!restaurant) {
      const slug = discoveryName
        .toLowerCase()
        .replace(/ /g, "-")
        .replace(/[^\w-]+/g, "");

      const [newShadow] = await db
        .insert(restaurants)
        .values({
          name: discoveryName,
          slug: `${slug}-${crypto.randomBytes(3).toString("hex")}`,
          ownerEmail: discoveryEmail,
          ownerId: "shadow",
          apiKey: `ts_shadow_${crypto.randomBytes(8).toString("hex")}`,
          isShadow: true,
          isClaimed: false,
        })
        .returning();

      restaurant = newShadow;
    }

    return restaurant;
  }
}

// Export singleton instance
export const reservationService = new ReservationService();
