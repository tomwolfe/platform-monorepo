/**
 * Test Database Setup Utilities (Table-Stack)
 *
 * Re-exports centralized test utilities from @repo/shared/testing.
 * Provides database setup, seeding, and cleanup utilities for integration tests.
 *
 * @deprecated Import directly from @repo/shared/testing in new tests
 */

export {
  checkDatabaseConnection,
  setupTestDatabase,
  cleanupTestDatabase,
  createTestRestaurant,
  createTestTables,
  createTestReservation,
  createTestGuestProfile,
  seedTestFixtures,
  cleanupRestaurantData,
  cleanupReservationData,
  getRestaurantWithDetails,
  getGuestProfileWithHistory,
  type TestRestaurantData,
  type TestReservationData,
} from "@repo/shared/testing";
