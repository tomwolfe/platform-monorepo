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
import { Logger } from "@repo/shared";
import { getRedisClient, ServiceNamespace } from "@repo/shared/redis";
import crypto from "crypto";

const logger = new Logger({ serviceName: "reservation-service" });

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

export interface AvailableTable {
  id: string;
  tableNumber: string;
  maxCapacity: number;
  minCapacity: number;
  tableType?: string;
  xPos?: number;
  yPos?: number;
  isCombined: boolean;
  combinedTableIds?: string[];
  table1?: typeof restaurantTables.$inferSelect;
  table2?: typeof restaurantTables.$inferSelect;
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
   * Get available tables for a specific time slot and party size.
   * Uses PostgreSQL OVERLAPS operators and circuit-breaking for combinations.
   */
  async getAvailableTables(
    restaurantId: string,
    startTime: Date,
    partySize: number,
    duration: number,
  ): Promise<AvailableTable[]> {
    const endTime = addMinutes(startTime, duration);
    const db = getDb();

    // Step 1: Find occupied table IDs using PostgreSQL OVERLAPS operator
    const occupiedTableIdsQuery = db
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
                restaurantReservations.createdAt,
                new Date(Date.now() - 15 * 60 * 1000),
              ),
            ),
          ),
          sql`(${restaurantReservations.startTime}, ${restaurantReservations.endTime}) OVERLAPS (${startTime.toISOString()}::timestamptz, ${endTime.toISOString()}::timestamptz)`,
        ),
      );

    const occupiedReservations = await occupiedTableIdsQuery;

    // Build a set of all occupied table IDs (including combined tables)
    const occupiedTableIds = new Set<string>();
    for (const res of occupiedReservations) {
      if (res.tableId) {
        occupiedTableIds.add(res.tableId);
      }
      if (res.combinedTableIds && Array.isArray(res.combinedTableIds)) {
        res.combinedTableIds.forEach((id: string) => occupiedTableIds.add(id));
      }
    }

    // Step 2: Fetch only available tables that match capacity requirements
    const occupiedIdsArray = Array.from(occupiedTableIds);
    const notInCondition =
      occupiedTableIds.size > 0
        ? sql`${restaurantTables.id} NOT IN (${sql.join(
            occupiedIdsArray.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql`1=1`;

    const availableIndividualTables = await db
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
          eq(restaurantTables.status, "vacant"),
          sql`${restaurantTables.maxCapacity} >= ${partySize}`,
          notInCondition,
        ),
      );

    if (availableIndividualTables.length > 0) {
      return availableIndividualTables.map((t) => ({
        ...t,
        isCombined: false,
      }));
    }

    // Step 3: If no individual table fits, try joining two tables
    const vacantTables = await db
      .select({
        id: restaurantTables.id,
        tableNumber: restaurantTables.tableNumber,
        maxCapacity: restaurantTables.maxCapacity,
        minCapacity: restaurantTables.minCapacity,
      })
      .from(restaurantTables)
      .where(
        and(
          eq(restaurantTables.restaurantId, restaurantId),
          eq(restaurantTables.isActive, true),
          eq(restaurantTables.status, "vacant"),
          notInCondition,
        ),
      );

    const suggestedCombos: Array<{
      id: string;
      tableNumber: string;
      combinedTableIds: string[];
      maxCapacity: number;
      isCombined: boolean;
      table1: typeof restaurantTables.$inferSelect;
      table2: typeof restaurantTables.$inferSelect;
    }> = [];

    // Circuit breaker: limit combinations to prevent O(N^2) event-loop blocking
    const MAX_COMBOS = 5;
    let comboCount = 0;

    // Pre-filter: exclude tables that cannot possibly satisfy partySize even when combined
    const MAX_KNOWN_TABLE_CAPACITY =
      vacantTables.length > 0
        ? Math.max(...vacantTables.map((t) => t.maxCapacity))
        : 0;

    const feasibleTables = vacantTables.filter(
      (t) => t.maxCapacity + MAX_KNOWN_TABLE_CAPACITY >= partySize,
    );

    comboSearch: for (let i = 0; i < feasibleTables.length; i++) {
      const t1 = feasibleTables[i];
      if (!t1) continue;

      if (t1.maxCapacity >= partySize) continue;

      for (let j = i + 1; j < feasibleTables.length; j++) {
        if (comboCount >= MAX_COMBOS) break comboSearch;
        const t2 = feasibleTables[j];
        if (!t1 || !t2) continue;

        const combinedCapacity = t1.maxCapacity + t2.maxCapacity;
        if (combinedCapacity < partySize) continue;

        const distance = Math.sqrt(
          Math.pow((t1.xPos || 0) - (t2.xPos || 0), 2) +
            Math.pow((t1.yPos || 0) - (t2.yPos || 0), 2),
        );

        if (distance < 120) {
          suggestedCombos.push({
            id: `${t1.id}+${t2.id}`,
            tableNumber: `${t1.tableNumber}+${t2.tableNumber}`,
            combinedTableIds: [t1.id, t2.id],
            maxCapacity: combinedCapacity,
            isCombined: true,
            table1: t1,
            table2: t2,
          });
          comboCount++;
        }
      }
    }

    if (
      comboCount >= MAX_COMBOS &&
      (vacantTables.length * (vacantTables.length - 1)) / 2 > MAX_COMBOS
    ) {
      logger.info("Table combination search capped by circuit breaker", {
        maxCombos: MAX_COMBOS,
        vacantTableCount: vacantTables.length,
        possibleCombos: (vacantTables.length * (vacantTables.length - 1)) / 2,
      });
    }

    return suggestedCombos;
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
      // Enforce strict DB-level timeout to prevent dangling locks in serverless
      await tx.execute(sql`SET LOCAL statement_timeout = '5000'`);

      // Auto-assign logic using atomic SQL CTE to prevent race conditions
      // Using a CTE (Common Table Expression) ensures the SELECT ... FOR UPDATE
      // and the INSERT happen in a single atomic SQL statement, avoiding the
      // lock-drop issue with Neon's stateless HTTP driver.
      if (
        !isShadow &&
        !assignedTableId &&
        (!combinedTableIds ||
          !Array.isArray(combinedTableIds) ||
          combinedTableIds.length === 0)
      ) {
        const cteResult = await tx.execute(sql`
          WITH available_table AS (
            SELECT id
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
          )
          INSERT INTO ${restaurantReservations} (
            restaurant_id, table_id, combined_table_ids, guest_name, guest_email,
            party_size, start_time, end_time, is_verified, metadata
          )
          SELECT
            ${restaurantId},
            id,
            NULL,
            ${guestName},
            ${guestEmail},
            ${partySize},
            ${start.toISOString()}::timestamptz,
            ${end.toISOString()}::timestamptz,
            ${isShadow},
            ${metadata || null}::jsonb
          FROM available_table
          RETURNING *
        `);

        if (!cteResult || cteResult.length === 0) {
          throw new ConflictError(
            "No suitable tables available for this time and party size",
          );
        }

        const insertedReservation = cteResult[0];
        assignedTableId = insertedReservation.table_id;

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

        return { newReservation: insertedReservation, profile };
      }

      // Conflict detection for non-shadow restaurants
      if (!isShadow) {
        const tablesToCheck = assignedTableId
          ? [assignedTableId]
          : combinedTableIds || [];

        // CRITICAL FIX: Prevent Drizzle/PostgreSQL crash on empty arrays in ANY() / && operators
        // PostgreSQL's ANY(empty_array) and array && empty_array both crash with:
        // "cannot determine type of empty array" — this guard ensures we only pass non-empty arrays
        const hasTablesToCheck = tablesToCheck.length > 0;

        if (!hasTablesToCheck && !assignedTableId) {
          // No tables to check and no assigned table — this is a logic error
          throw new ConflictError(
            "No table specified. Either tableId or combinedTableIds must be provided.",
          );
        }

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
              // Single table check
              assignedTableId
                ? eq(restaurantReservations.tableId, assignedTableId)
                : undefined,
              // Combined table contains single table
              assignedTableId
                ? sql`${restaurantReservations.combinedTableIds} @> ${JSON.stringify([assignedTableId])}::jsonb`
                : undefined,
              // Table ID is in the combined table IDs list (only if list is non-empty)
              combinedTableIds && hasTablesToCheck
                ? sql`${restaurantReservations.tableId} = ANY(${tablesToCheck}::uuid[])`
                : undefined,
              // Combined table IDs overlap with the check list (only if list is non-empty)
              combinedTableIds && hasTablesToCheck
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
   * Invalidate availability cache for a restaurant.
   * Called after a booking is created to ensure fresh data on next read.
   */
  async invalidateAvailabilityCache(
    restaurantId: string,
    date?: string,
  ): Promise<void> {
    try {
      const redis = getRedisClient(ServiceNamespace.TS);
      if (date) {
        // Invalidate specific date cache keys
        // Pattern: availability:{restaurantId}:{date}:*
        const pattern = `availability:${restaurantId}:${date}:*`;
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } else {
        // Invalidate all availability cache for this restaurant
        const pattern = `availability:${restaurantId}:*`;
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      }
    } catch (error) {
      // Cache invalidation failure is non-fatal — the cache will expire naturally
      logger.warn("Failed to invalidate availability cache", {
        restaurantId,
        date,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
