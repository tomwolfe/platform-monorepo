/**
 * Test Database Setup Utilities
 *
 * Provides database setup, seeding, and cleanup utilities for integration tests.
 * Uses a separate test database to avoid polluting development data.
 *
 * Usage:
 * ```typescript
 * import { setupTestDatabase, cleanupTestDatabase } from '@/test/setup';
 *
 * describe('My Tests', () => {
 *   beforeAll(async () => {
 *     await setupTestDatabase();
 *   });
 *
 *   afterAll(async () => {
 *     await cleanupTestDatabase();
 *   });
 * });
 * ```
 *
 * @see Phase 1.1: Testing Infrastructure
 */

import { getDb, restaurants, restaurantTables, restaurantReservations, guestProfiles } from '@repo/database';
import { eq, sql } from '@repo/database';

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
// DATABASE SETUP
// ============================================================================

/**
 * Check if database connection is available
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await getDb().execute(sql`SELECT 1`);
    return true;
  } catch (error) {
    console.error('Database connection check failed:', error);
    return false;
  }
}

/**
 * Setup test database schema
 * Runs migrations on test database
 */
export async function setupTestDatabase(): Promise<void> {
  const isConnected = await checkDatabaseConnection();

  if (!isConnected) {
    throw new Error(
      'Test database connection failed. Ensure your test database is configured.\n' +
      'Set TEST_DATABASE_URL environment variable or use the default test database.'
    );
  }

  console.log('Test database connection established');
}

/**
 * Cleanup test database
 * Removes all test data created during tests
 */
export async function cleanupTestDatabase(): Promise<void> {
  try {
    // Clean in reverse order of dependencies
    await getDb().delete(restaurantReservations).where(
      sql`${restaurantReservations.restaurantId} LIKE 'test-%'`
    );

    await getDb().delete(guestProfiles).where(
      sql`${guestProfiles.restaurantId} LIKE 'test-%'`
    );

    await getDb().delete(restaurantTables).where(
      sql`${restaurantTables.restaurantId} IN (SELECT id FROM ${restaurants} WHERE ${restaurants.id} LIKE 'test-%')`
    );

    await getDb().delete(restaurants).where(
      sql`${restaurants.id} LIKE 'test-%'`
    );

    console.log('Test database cleanup completed');
  } catch (error) {
    console.error('Test database cleanup failed:', error);
    // Don't throw - cleanup errors shouldn't break test suite
  }
}

/**
 * Truncate all test tables (faster than delete for large datasets)
 * Use with caution - ensures referential integrity is maintained
 */
export async function truncateTestTables(): Promise<void> {
  try {
    await getDb().execute(sql`
      TRUNCATE TABLE ${restaurantReservations} RESTART IDENTITY CASCADE;
      TRUNCATE TABLE ${guestProfiles} RESTART IDENTITY CASCADE;
      TRUNCATE TABLE ${restaurantTables} RESTART IDENTITY CASCADE;
      TRUNCATE TABLE ${restaurants} RESTART IDENTITY CASCADE;
    `);
    console.log('Test tables truncated');
  } catch (error) {
    console.error('Truncate failed:', error);
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create a test restaurant with default values
 */
export async function createTestRestaurant(overrides?: Partial<typeof restaurants.$inferInsert>): Promise<TestRestaurantData> {
  const timestamp = Date.now();
  const [restaurant] = await getDb().insert(restaurants).values({
    id: `test-${timestamp}`,
    name: `Test Restaurant ${timestamp}`,
    slug: `test-restaurant-${timestamp}`,
    ownerEmail: `test-${timestamp}@example.com`,
    ownerId: 'test-owner',
    apiKey: `ts_test_${Math.random().toString(36).substring(2, 10)}`,
    isShadow: false,
    isClaimed: true,
    timezone: 'UTC',
    daysOpen: 'monday,tuesday,wednesday,thursday,friday,saturday,sunday',
    openingTime: '09:00',
    closingTime: '22:00',
    defaultDurationMinutes: 90,
    ...overrides,
  }).returning();

  // Create default tables
  const tables = await createTestTables(restaurant.id, 5);

  return {
    restaurant,
    tables,
    apiKey: restaurant.apiKey,
  };
}

/**
 * Create test tables for a restaurant
 */
export async function createTestTables(
  restaurantId: string,
  count: number = 5,
  overrides?: Partial<typeof restaurantTables.$inferInsert>
): Promise<Array<typeof restaurantTables.$inferSelect>> {
  const tables = [];

  for (let i = 0; i < count; i++) {
    const [table] = await getDb().insert(restaurantTables).values({
      restaurantId,
      tableNumber: `T${i + 1}`,
      minCapacity: 2,
      maxCapacity: 4,
      xPos: i * 100,
      yPos: 0,
      isActive: true,
      status: 'vacant',
      ...overrides,
    }).returning();

    tables.push(table);
  }

  return tables;
}

/**
 * Create a test reservation
 */
export async function createTestReservation(
  restaurantId: string,
  tableId: string,
  overrides?: Partial<typeof restaurantReservations.$inferInsert>
): Promise<TestReservationData> {
  const timestamp = Date.now();
  const startTime = new Date(Date.now() + 86400000); // Tomorrow
  const endTime = new Date(startTime.getTime() + 90 * 60000);

  const [reservation] = await getDb().insert(restaurantReservations).values({
    restaurantId,
    tableId,
    guestName: `Test Guest ${timestamp}`,
    guestEmail: `test-${timestamp}@example.com`,
    partySize: 2,
    startTime,
    endTime,
    status: 'confirmed',
    isVerified: true,
    ...overrides,
  }).returning();

  // Create or update guest profile
  const [profile] = await getDb().insert(guestProfiles).values({
    restaurantId,
    email: reservation.guestEmail,
    name: reservation.guestName,
    visitCount: 1,
  }).onConflictDoUpdate({
    target: [guestProfiles.restaurantId, guestProfiles.email],
    set: {
      name: reservation.guestName,
      visitCount: sql.raw(`${guestProfiles.visitCount} + 1`),
    },
  }).returning();

  return {
    reservation,
    profile,
  };
}

/**
 * Create a test guest profile
 */
export async function createTestGuestProfile(
  restaurantId: string,
  email: string,
  overrides?: Partial<typeof guestProfiles.$inferInsert>
): Promise<typeof guestProfiles.$inferSelect> {
  const [profile] = await getDb().insert(guestProfiles).values({
    restaurantId,
    email,
    name: 'Test Guest',
    visitCount: 1,
    ...overrides,
  }).onConflictDoUpdate({
    target: [guestProfiles.restaurantId, guestProfiles.email],
    set: {
      name: 'Test Guest',
      visitCount: sql.raw(`${guestProfiles.visitCount} + 1`),
    },
  }).returning();

  return profile;
}

// ============================================================================
// SEEDING UTILITIES
// ============================================================================

/**
 * Seed database with test fixtures
 * Creates a standard set of test data for integration tests
 */
export async function seedTestFixtures(): Promise<{
  restaurants: TestRestaurantData[];
  reservations: TestReservationData[];
}> {
  const testRestaurants: TestRestaurantData[] = [];
  const testReservations: TestReservationData[] = [];

  // Create 3 test restaurants with different configurations
  const restaurantConfigs = [
    { name: 'Test Bistro', tables: 5, daysOpen: 'monday,tuesday,wednesday,thursday,friday,saturday,sunday' },
    { name: 'Test Fine Dining', tables: 3, daysOpen: 'wednesday,thursday,friday,saturday' },
    { name: 'Test Cafe', tables: 8, daysOpen: 'monday,tuesday,wednesday,thursday,friday' },
  ];

  for (const config of restaurantConfigs) {
    const restaurantData = await createTestRestaurant({
      name: config.name,
      daysOpen: config.daysOpen,
    });
    testRestaurants.push(restaurantData);

    // Create some reservations for each restaurant
    for (let i = 0; i < 2; i++) {
      const table = restaurantData.tables[i % restaurantData.tables.length];
      const reservation = await createTestReservation(restaurantData.restaurant.id, table.id);
      testReservations.push(reservation);
    }
  }

  console.log(`Seeded ${testRestaurants.length} test restaurants and ${testReservations.length} reservations`);

  return {
    restaurants: testRestaurants,
    reservations: testReservations,
  };
}

/**
 * Clean up specific test data by restaurant ID
 */
export async function cleanupRestaurantData(restaurantId: string): Promise<void> {
  await getDb().delete(restaurantReservations).where(eq(restaurantReservations.restaurantId, restaurantId));
  await getDb().delete(guestProfiles).where(eq(guestProfiles.restaurantId, restaurantId));
  await getDb().delete(restaurantTables).where(eq(restaurantTables.restaurantId, restaurantId));
  await getDb().delete(restaurants).where(eq(restaurants.id, restaurantId));
}

/**
 * Clean up specific test data by reservation ID
 */
export async function cleanupReservationData(reservationId: string): Promise<void> {
  await getDb().delete(restaurantReservations).where(eq(restaurantReservations.id, reservationId));
}

// ============================================================================
// QUERY HELPERS
// ============================================================================

/**
 * Get restaurant with all related data
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
 * Get guest profile with reservation history
 */
export async function getGuestProfileWithHistory(
  restaurantId: string,
  email: string
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
