/**
 * Vitest Setup File for TableStack
 *
 * Global test configuration, mocks, and setup for table-stack tests.
 *
 * @see Phase 1.1: Testing Infrastructure
 */

import { vi, beforeEach, afterEach, afterAll } from "vitest";

// ============================================================================
// MOCKS - MUST BE HOISTED BEFORE IMPORTS
// ============================================================================

/**
 * Mock Next.js server modules
 */
vi.mock("next/server", async (importActual) => {
  const actual = await importActual();
  return {
    ...(actual as Record<string, unknown>),
    NextRequest: function (url: string | URL, init?: RequestInit) {
      return new Request(typeof url === "string" ? url : url.toString(), init);
    },
    NextResponse: {
      json: vi.fn((data: Record<string, unknown>, init?: ResponseInit) => {
        return new Response(JSON.stringify(data), {
          ...init,
          headers: {
            ...init?.headers,
            "content-type": "application/json",
          },
        });
      }),
      redirect: vi.fn((url: string, status?: number) => {
        return new Response(null, {
          status: status || 302,
          headers: {
            location: url,
          },
        });
      }),
    },
  };
});

/**
 * Mock @tablestack/lib/auth for integration tests
 */
vi.mock("@tablestack/lib/auth", () => ({
  validateRequest: vi.fn(() =>
    Promise.resolve({
      context: { restaurantId: "test-restaurant", isInternal: true },
    }),
  ),
}));

/**
 * Mock @repo/shared/middleware/serverless-timeout to avoid next/server import issues
 */
vi.mock("@repo/shared/middleware/serverless-timeout", () => ({
  withServerlessTimeout: vi.fn(
    (handler: (req: Request) => Promise<Response>) => handler,
  ),
}));

/**
 * Mock @tablestack/lib/notifications for integration tests
 */
vi.mock("@tablestack/lib/notifications", () => ({
  NotifyService: {
    broadcast: vi.fn(() => Promise.resolve()),
    notifyExternalDelivery: vi.fn(() => Promise.resolve()),
    notifyRejection: vi.fn(() => Promise.resolve()),
    sendEmail: vi.fn(() => Promise.resolve()),
  },
}));

/**
 * Mock @tablestack/lib/redis for integration tests
 */
vi.mock("@tablestack/lib/redis", () => ({
  redis: {
    get: vi.fn(() => Promise.resolve(null)),
    set: vi.fn(() => Promise.resolve("OK")),
    setex: vi.fn(() => Promise.resolve("OK")),
    del: vi.fn(() => Promise.resolve(0)),
    lpush: vi.fn(() => Promise.resolve(1)),
    rpush: vi.fn(() => Promise.resolve(1)),
    lrange: vi.fn(() => Promise.resolve([])),
    expire: vi.fn(() => Promise.resolve(1)),
  },
}));

/**
 * Mock @repo/database for integration tests
 * FIX: Properly mock Drizzle's transaction pattern
 */
vi.mock("@repo/database", async () => {
  const actual = await vi.importActual("@repo/database");

  // Create mock query objects
  const mockRestaurantsQuery = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  };

  const mockRestaurantReservationsQuery = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  };

  const mockRestaurantTablesQuery = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  };

  const mockGuestProfilesQuery = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  };

  // Create mock transaction executor
  const createMockTransaction = () => ({
    execute: vi.fn().mockResolvedValue([]),
    query: {
      restaurants: mockRestaurantsQuery,
      restaurantReservations: mockRestaurantReservationsQuery,
      restaurantTables: mockRestaurantTablesQuery,
      guestProfiles: mockGuestProfilesQuery,
    },
    insert: vi.fn().mockImplementation((table: unknown) => ({
      values: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    })),
    update: vi.fn().mockImplementation((table: unknown) => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    })),
    delete: vi.fn().mockImplementation((table: unknown) => ({
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
  type MockTransaction = ReturnType<typeof createMockTransaction>;

  return {
    ...(actual as Record<string, unknown>),
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
          // Properly call the function with a mock transaction object
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
});

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import { cleanupTestDatabase } from "@repo/shared/testing";

// ============================================================================
// GLOBAL TIMEOUT CONFIGURATION
// ============================================================================

// Set global test timeout to 30 seconds for integration tests
vi.setConfig({
  testTimeout: 30000,
  hookTimeout: 30000,
});

// ============================================================================
// ENVIRONMENT VARIABLES
// ============================================================================

// Set test environment variables
process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://test:test@localhost:5432/test_db";
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
process.env.REDIS_URL = process.env.REDIS_URL || "http://localhost:6379";

// Mock sensitive environment variables for tests
process.env.INTERNAL_SYSTEM_KEY = "test-system-key";
process.env.UPSTASH_REDIS_REST_URL = "http://localhost:6379";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

// ============================================================================
// TEST CLEANUP
// ============================================================================

/**
 * Reset all mocks and module state before each test to ensure isolation.
 * This prevents state leakage between tests (e.g., memoized values, singleton instances).
 */
beforeEach(() => {
  vi.resetAllMocks();
});

/**
 * Cleanup after each test to prevent test pollution
 */
afterEach(async () => {
  vi.clearAllMocks();
});

/**
 * Global cleanup after all tests
 */
afterAll(async () => {
  // Attempt to cleanup test database (will fail gracefully if not connected)
  try {
    await cleanupTestDatabase();
  } catch (error) {
    // Ignore cleanup errors in test environment
    console.warn("Test database cleanup skipped:", error);
  }
});

// ============================================================================
// TYPE DECLARATIONS
// ============================================================================

declare global {
  /**
   * Wait for a specified number of milliseconds
   */
  function waitFor(ms: number): Promise<void>;

  /**
   * Create a promise that never resolves
   */
  function neverResolves(): Promise<never>;

  /**
   * Suppress console output during tests
   */
  function suppressConsole(): void;

  /**
   * Restore console output
   */
  function restoreConsole(): void;
}

// ============================================================================
// EXPORTS
// ============================================================================

export {};
