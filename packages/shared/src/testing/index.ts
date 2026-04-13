/**
 * Shared Testing Utilities
 *
 * Centralized testing infrastructure for the platform monorepo.
 * Provides MSW handlers, database utilities, test factories, and mock objects.
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

// Integration Test Utilities (retry, timeout, eventual consistency)
export {
  withRetry,
  withTimeout,
  eventually,
  waitForCondition,
  safeCleanup,
  testId,
  type RetryOptions,
} from "./integration-utils";

// Mock Object Factories
export {
  createMockRedisClient,
  createMockGetRedisClientFactory,
  type MockRedisClient,
  type MockRedisOptions,
} from "./mocks/redis";

export { createMockLogger, type MockLogger } from "./mocks/logger";

// Web3 Testing Utilities (Anvil, viem mocks, MSW RPC handlers)
export {
  setupViemMocks,
  setupWagmiMocks,
  setupERC20Mock,
  createMockPublicClient,
  getAnvilRpcUrl,
  isAnvilRunning,
  skipIfAnvilNotRunning,
  createWeb3RpcHandlers,
} from "./web3";
