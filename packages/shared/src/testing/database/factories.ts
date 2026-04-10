/**
 * Test Database Factory Functions
 *
 * Centralized factory functions for creating test data in integration tests.
 * Eliminates duplication across apps and provides consistent test data creation.
 *
 * @package @repo/shared
 * @since 1.0.0
 *
 * @example
 * ```ts
 * import { createTestRestaurant, createTestReservation } from '@repo/shared/testing';
 *
 * const { restaurant, tables, apiKey } = await createTestRestaurant();
 * const { reservation, profile } = await createTestReservation(restaurant.id, tables[0].id);
 * ```
 */

import {
  getDb,
  restaurants,
  restaurantTables,
  restaurantReservations,
  guestProfiles,
} from "@repo/database";
import { eq, sql } from "@repo/database";

// ============================================================================
// TYPES
// ============================================================================

export interface TestRestaurantData {
  restaurant: typeof restaurants.$inferSelect;
  tables: Array<typeof restaurantTables.$inferSelect>;
  apiKey: string;
}

export interface TestReservationData {
  reservation: typeof restaurantReservations.$inferSelect;
  profile?: typeof guestProfiles.$inferSelect;
}

// ============================================================================
// DATABASE CONNECTION
// ============================================================================

/**
 * Verify database connection is available.
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await getDb().execute(sql`SELECT 1`);
    return true;
  } catch (error) {
    console.error("Database connection check failed:", error);
    return false;
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create a test restaurant with default values and 5 default tables.
 *
 * @param overrides - Partial restaurant data to override defaults
 */
export async function createTestRestaurant(
  overrides?: Partial<typeof restaurants.$inferInsert>,
): Promise<TestRestaurantData> {
  const timestamp = Date.now();
  const [restaurant] = await getDb()
    .insert(restaurants)
    .values({
      id: `test-${timestamp}`,
      name: `Test Restaurant ${timestamp}`,
      slug: `test-restaurant-${timestamp}`,
      ownerEmail: `test-${timestamp}@example.com`,
      ownerId: "test-owner",
      apiKey: `ts_test_${Math.random().toString(36).substring(2, 10)}`,
      isShadow: false,
      isClaimed: true,
      timezone: "UTC",
      daysOpen: "monday,tuesday,wednesday,thursday,friday,saturday,sunday",
      openingTime: "09:00",
      closingTime: "22:00",
      defaultDurationMinutes: 90,
      ...overrides,
    })
    .returning();

  const tables = await createTestTables(restaurant.id, 5);

  return {
    restaurant,
    tables,
    apiKey: restaurant.apiKey,
  };
}

/**
 * Create N test tables for a restaurant.
 *
 * @param restaurantId - Parent restaurant ID
 * @param count - Number of tables to create (default: 5)
 * @param overrides - Partial table data to override defaults
 */
export async function createTestTables(
  restaurantId: string,
  count: number = 5,
  overrides?: Partial<typeof restaurantTables.$inferInsert>,
): Promise<Array<typeof restaurantTables.$inferSelect>> {
  const tables = [];

  for (let i = 0; i < count; i++) {
    const [table] = await getDb()
      .insert(restaurantTables)
      .values({
        restaurantId,
        tableNumber: `T${i + 1}`,
        minCapacity: 2,
        maxCapacity: 4,
        xPos: i * 100,
        yPos: 0,
        isActive: true,
        status: "vacant",
        ...overrides,
      })
      .returning();

    tables.push(table);
  }

  return tables;
}

/**
 * Create a test reservation with an associated guest profile.
 *
 * @param restaurantId - Parent restaurant ID
 * @param tableId - Table to reserve
 * @param overrides - Partial reservation data to override defaults
 */
export async function createTestReservation(
  restaurantId: string,
  tableId: string,
  overrides?: Partial<typeof restaurantReservations.$inferInsert>,
): Promise<TestReservationData> {
  const timestamp = Date.now();
  const startTime = new Date(Date.now() + 86400000); // Tomorrow
  const endTime = new Date(startTime.getTime() + 90 * 60000);

  const [reservation] = await getDb()
    .insert(restaurantReservations)
    .values({
      restaurantId,
      tableId,
      guestName: `Test Guest ${timestamp}`,
      guestEmail: `test-${timestamp}@example.com`,
      partySize: 2,
      startTime,
      endTime,
      status: "confirmed",
      isVerified: true,
      ...overrides,
    })
    .returning();

  // Create or update guest profile
  const [profile] = await getDb()
    .insert(guestProfiles)
    .values({
      restaurantId,
      email: reservation.guestEmail,
      name: reservation.guestName,
      visitCount: 1,
    })
    .onConflictDoUpdate({
      target: [guestProfiles.restaurantId, guestProfiles.email],
      set: {
        name: reservation.guestName,
        visitCount: sql.raw(`${guestProfiles.visitCount} + 1`),
      },
    })
    .returning();

  return {
    reservation,
    profile,
  };
}

/**
 * Create or update a guest profile.
 *
 * @param restaurantId - Parent restaurant ID
 * @param email - Guest email (unique key for upsert)
 * @param overrides - Partial profile data to override defaults
 */
export async function createTestGuestProfile(
  restaurantId: string,
  email: string,
  overrides?: Partial<typeof guestProfiles.$inferInsert>,
): Promise<typeof guestProfiles.$inferSelect> {
  const [profile] = await getDb()
    .insert(guestProfiles)
    .values({
      restaurantId,
      email,
      name: "Test Guest",
      visitCount: 1,
      ...overrides,
    })
    .onConflictDoUpdate({
      target: [guestProfiles.restaurantId, guestProfiles.email],
      set: {
        name: "Test Guest",
        visitCount: sql.raw(`${guestProfiles.visitCount} + 1`),
      },
    })
    .returning();

  return profile;
}

// ============================================================================
// SEEDING UTILITIES
// ============================================================================

/**
 * Seed database with standard test fixtures.
 * Creates 3 restaurants with 2 reservations each.
 */
export async function seedTestFixtures(): Promise<{
  restaurants: TestRestaurantData[];
  reservations: TestReservationData[];
}> {
  const testRestaurants: TestRestaurantData[] = [];
  const testReservations: TestReservationData[] = [];

  const restaurantConfigs = [
    {
      name: "Test Bistro",
      tables: 5,
      daysOpen: "monday,tuesday,wednesday,thursday,friday,saturday,sunday",
    },
    {
      name: "Test Fine Dining",
      tables: 3,
      daysOpen: "wednesday,thursday,friday,saturday",
    },
    {
      name: "Test Cafe",
      tables: 8,
      daysOpen: "monday,tuesday,wednesday,thursday,friday",
    },
  ];

  for (const config of restaurantConfigs) {
    const restaurantData = await createTestRestaurant({
      name: config.name,
      daysOpen: config.daysOpen,
    });
    testRestaurants.push(restaurantData);

    for (let i = 0; i < 2; i++) {
      const table = restaurantData.tables[i % restaurantData.tables.length];
      const reservation = await createTestReservation(
        restaurantData.restaurant.id,
        table.id,
      );
      testReservations.push(reservation);
    }
  }

  console.log(
    `Seeded ${testRestaurants.length} restaurants and ${testReservations.length} reservations`,
  );

  return {
    restaurants: testRestaurants,
    reservations: testReservations,
  };
}

// ============================================================================
// CLEANUP UTILITIES
// ============================================================================

/**
 * Cleanup test database schema.
 * Removes all tables from the public schema.
 */
export async function cleanupTestDatabase(): Promise<void> {
  try {
    await getDb().execute(sql`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);
    console.log("Test database cleanup completed");
  } catch (error) {
    console.error("Test database cleanup failed:", error);
    // Don't throw - cleanup errors shouldn't break test suite
  }
}

/**
 * Clean up specific restaurant data by ID.
 */
export async function cleanupRestaurantData(
  restaurantId: string,
): Promise<void> {
  await getDb()
    .delete(restaurantReservations)
    .where(eq(restaurantReservations.restaurantId, restaurantId));
  await getDb()
    .delete(guestProfiles)
    .where(eq(guestProfiles.restaurantId, restaurantId));
  await getDb()
    .delete(restaurantTables)
    .where(eq(restaurantTables.restaurantId, restaurantId));
  await getDb().delete(restaurants).where(eq(restaurants.id, restaurantId));
}

/**
 * Clean up specific reservation data by ID.
 */
export async function cleanupReservationData(
  reservationId: string,
): Promise<void> {
  await getDb()
    .delete(restaurantReservations)
    .where(eq(restaurantReservations.id, reservationId));
}

// ============================================================================
// QUERY HELPERS
// ============================================================================

/**
 * Get restaurant with all related data (tables, reservations).
 */
export async function getRestaurantWithDetails(restaurantId: string): Promise<{
  restaurant: typeof restaurants.$inferSelect;
  tables: Array<typeof restaurantTables.$inferSelect>;
  reservations: Array<typeof restaurantReservations.$inferSelect>;
} | null> {
  const restaurant = await getDb().query.restaurants.findFirst({
    where: eq(restaurants.id, restaurantId),
    with: {
      restaurantTables: true,
      restaurantReservations: true,
    },
  });

  if (!restaurant) return null;

  return {
    restaurant,
    tables: restaurant.restaurantTables || [],
    reservations: restaurant.restaurantReservations || [],
  };
}

/**
 * Get guest profile with reservation history.
 */
export async function getGuestProfileWithHistory(
  _restaurantId: string,
  email: string,
): Promise<{
  profile: typeof guestProfiles.$inferSelect;
  reservations: Array<typeof restaurantReservations.$inferSelect>;
} | null> {
  const profile = await getDb().query.guestProfiles.findFirst({
    where: eq(guestProfiles.email, email),
  });

  if (!profile) return null;

  const reservations = await getDb().query.restaurantReservations.findMany({
    where: eq(restaurantReservations.guestEmail, email),
  });

  return {
    profile,
    reservations,
  };
}
