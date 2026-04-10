/**
 * Shared Testing Utilities
 *
 * Centralized testing infrastructure for the platform monorepo.
 * Provides MSW handlers, database utilities, and test factories.
 *
 * @package @repo/shared
 * @since 1.0.0
 */

// MSW Integration Test Handlers
export {
  web3RpcHandlers,
  ablyHandlers,
  resendHandlers,
  priceOracleHandlers,
  setupIntegrationMocks,
  type MockServerInstance,
} from "./msw/handlers";

// Database Setup & Teardown
export { setupTestDatabase, teardownTestDatabase } from "./database/setup";

// Database Factory Functions & Query Helpers
export {
  checkDatabaseConnection,
  createTestRestaurant,
  createTestTables,
  createTestReservation,
  createTestGuestProfile,
  seedTestFixtures,
  cleanupTestDatabase,
  cleanupRestaurantData,
  cleanupReservationData,
  getRestaurantWithDetails,
  getGuestProfileWithHistory,
  type TestRestaurantData,
  type TestReservationData,
} from "./database/factories";
