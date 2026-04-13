/**
 * @repo/database Mock
 *
 * Centralized mock for Drizzle database client.
 * Properly mocks the transaction pattern and query builders.
 *
 * @see Task 5: Clean Up vitest-setup.ts
 */

import { vi } from "vitest";

// Create mock query objects
export const mockRestaurantsQuery = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
};

export const mockRestaurantReservationsQuery = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
};

export const mockRestaurantTablesQuery = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
};

export const mockGuestProfilesQuery = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
};

// Create mock transaction executor
export const createMockTransaction = () => ({
  execute: vi.fn().mockResolvedValue([]),
  query: {
    restaurants: mockRestaurantsQuery,
    restaurantReservations: mockRestaurantReservationsQuery,
    restaurantTables: mockRestaurantTablesQuery,
    guestProfiles: mockGuestProfilesQuery,
  },
  insert: vi.fn().mockImplementation((_table: unknown) => ({
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  })),
  update: vi.fn().mockImplementation((_table: unknown) => ({
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  })),
  delete: vi.fn().mockImplementation((_table: unknown) => ({
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  })),
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
});

// Type for mock transaction
export type MockTransaction = ReturnType<typeof createMockTransaction>;

/**
 * Database mock factory
 * Returns a fully mocked database instance
 */
export function createMockDatabase() {
  return {
    getDb: vi.fn(() => ({
      query: {
        restaurants: mockRestaurantsQuery,
        restaurantReservations: mockRestaurantReservationsQuery,
        restaurantTables: mockRestaurantTablesQuery,
        guestProfiles: mockGuestProfilesQuery,
      },
      insert: vi.fn().mockImplementation((_table: unknown) => ({
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([]),
      })),
      update: vi.fn().mockImplementation((_table: unknown) => ({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([]),
      })),
      delete: vi.fn().mockImplementation((_table: unknown) => ({
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([]),
      })),
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      transaction: vi.fn(
        async (fn: (tx: MockTransaction) => Promise<unknown>) => {
          return await fn(createMockTransaction());
        },
      ),
    })),
    restaurants: {
      apiKey: "apiKey",
      id: "id",
    },
    restaurantReservations: {
      verificationToken: "verificationToken",
      id: "id",
    },
    eq: vi.fn(),
  };
}
