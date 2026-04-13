/**
 * Test Mocks Index
 *
 * Centralized export point for all test mocks.
 * Import mocks from here instead of duplicating in vitest-setup.ts
 *
 * @see Task 5: Clean Up vitest-setup.ts
 *
 * Usage:
 * ```typescript
 * import { createMockDatabase } from '@/test/__mocks__';
 * ```
 */

export {
  createMockDatabase,
  mockRestaurantsQuery,
  mockRestaurantReservationsQuery,
  mockRestaurantTablesQuery,
  mockGuestProfilesQuery,
  createMockTransaction,
  type MockTransaction,
} from "./@repo/database";

export {
  createMockShared,
  mockRedisClient,
  MockLogger,
  MockAppConfig,
} from "./@repo/shared";

export {
  createMockTablestack,
  MockNotifyService,
  MockAuth,
  MockRedis,
} from "./@tablestack/lib";
