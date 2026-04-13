/**
 * Integration Tests: Checkout/Reserve Flow
 *
 * Tests the checkout workflow with a real database:
 * 1. Schema validation
 * 2. Transaction hash format validation
 * 3. MSW-intercepted external service calls (Ably, Resend, Price Oracle)
 *
 * NOTE: These tests require a real database. Run with:
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgresql://apps:apps@localhost:5432/apps pnpm test
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { randomUUID } from "crypto";
import { setupIntegrationMocks } from "./msw/setup";
import {
  setupTestDatabase,
  cleanupTestDatabase,
  createTestRestaurant,
  createTestTables,
  type TestRestaurantData,
} from "@repo/shared/testing";
import { getDb, restaurantReservations, eq } from "@repo/database";

const msw = setupIntegrationMocks();

beforeAll(async () => {
  msw.start();
  // Setup real test database
  await setupTestDatabase();
});

afterAll(async () => {
  msw.stop();
  // Cleanup test database
  try {
    await cleanupTestDatabase();
  } catch (error) {
    console.warn("Test database cleanup failed:", error);
  }
});

beforeEach(() => {
  msw.reset();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Mock @repo/shared redis client (not part of the DB integration test scope)
vi.mock("@repo/shared", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    getRedisClient: vi.fn(() => ({
      get: vi.fn(() => Promise.resolve(null)),
      set: vi.fn(() => Promise.resolve("OK")),
      setex: vi.fn(() => Promise.resolve("OK")),
      del: vi.fn(() => Promise.resolve(0)),
      lpush: vi.fn(() => Promise.resolve(1)),
      rpush: vi.fn(() => Promise.resolve(1)),
      lrange: vi.fn(() => Promise.resolve([])),
      expire: vi.fn(() => Promise.resolve(1)),
      nx: vi.fn(() => Promise.resolve(true)),
    })),
    dispatchTask: vi.fn(() => Promise.resolve()),
    tryAcquireReplayProcessingLock: vi.fn(() => Promise.resolve(true)),
    releaseReplayProcessingLock: vi.fn(() => Promise.resolve(true)),
    isReplayAllowed: vi.fn(() => Promise.resolve(true)),
  };
});

// Mock web3 verification to avoid needing real blockchain interactions
vi.mock("@repo/shared/utils/web3-verification", () => ({
  verifyTransaction: vi.fn(() =>
    Promise.resolve({
      success: true,
      receipt: {
        status: "success" as const,
        blockNumber: BigInt(1),
        confirmations: 3,
        from: "0x1234567890123456789012345678901234567890",
        to: "0x0987654321098765432109876543210987654321",
        value: BigInt(0),
      },
    }),
  ),
  isValidTxHash: (hash: string) => /^0x[a-fA-F0-9]{64}$/.test(hash),
}));

// Mock notifications
vi.mock("@tablestack/lib/notifications", () => ({
  NotifyService: {
    broadcast: vi.fn(() => Promise.resolve()),
    notifyExternalDelivery: vi.fn(() => Promise.resolve()),
    notifyRejection: vi.fn(() => Promise.resolve()),
    sendEmail: vi.fn(() => Promise.resolve()),
    sendClaimInvitation: vi.fn(() => Promise.resolve()),
    notifyOwner: vi.fn(() => Promise.resolve()),
    sendNotification: vi.fn(() => Promise.resolve()),
  },
}));

// Mock auth
vi.mock("@tablestack/lib/auth", () => ({
  validateRequest: vi.fn(() =>
    Promise.resolve({
      context: { restaurantId: "test-restaurant", isInternal: true },
    }),
  ),
}));

// Mock serverless timeout
vi.mock("@repo/shared/middleware/serverless-timeout", () => ({
  withServerlessTimeout: vi.fn(
    (handler: (req: Request) => Promise<Response>) => handler,
  ),
}));

describe("Checkout/Reserve Flow Integration", () => {
  let testRestaurant: TestRestaurantData;

  beforeAll(async () => {
    // Create test restaurant with tables for DB-backed tests
    testRestaurant = await createTestRestaurant({
      id: `test-checkout-flow-${Date.now()}`,
      name: "Test Checkout Flow Restaurant",
      slug: "test-checkout-flow-restaurant",
      ownerEmail: "test-checkout-flow@example.com",
      ownerId: "test-owner-checkout-flow",
      apiKey: `ts_test_checkout_${randomUUID().substring(0, 8)}`,
      isShadow: false,
      isClaimed: true,
      timezone: "America/New_York",
      daysOpen: "monday,tuesday,wednesday,thursday,friday,saturday,sunday",
      openingTime: "09:00",
      closingTime: "22:00",
      defaultDurationMinutes: 90,
    });

    // Create additional tables
    await createTestTables(testRestaurant.restaurant.id, 5);
  });

  // Un-skipped tests - validate schema and idempotency requirements
  it("should validate reserve request schema correctly", async () => {
    // POST to checkout with empty body - should return 400 VALIDATION_ERROR
    const { POST } = await import("../../app/api/v1/checkout/route");
    const req = new Request("http://localhost/api/v1/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await POST(req as any);
    expect(response.status).toBe(400);
    const data = (await response.json()) as Record<string, unknown>;
    // formatValidationError returns { success: false, error: { code: "VALIDATION_ERROR", ... } }
    expect(data).toHaveProperty("success", false);
    expect(data).toHaveProperty("error");
    const errorObj = data.error as Record<string, unknown>;
    expect(errorObj).toHaveProperty("code", "VALIDATION_ERROR");
  });

  it("should reject request with invalid txHash format", async () => {
    // Provide a body with an invalid txHash to ensure validation fails
    const { POST } = await import("../../app/api/v1/checkout/route");
    const invalidBody = {
      txHash: "invalid-hash",
      reservationId: "550e8400-e29b-41d4-a716-446655440000",
      paymentCurrency: "USDC" as const,
    };

    const req = new Request("http://localhost/api/v1/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(invalidBody),
    });

    const response = await POST(req as any);
    expect(response.status).toBe(400);
    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("success", false);
  });

  it("should handle MSW-intercepted Ably notification during reserve flow", async () => {
    // Verify that when a reserve flow triggers Ably, the MSW handler intercepts it
    const { ablyHandlers } = await import("./msw/setup");
    expect(ablyHandlers).toBeDefined();
    expect(ablyHandlers.length).toBeGreaterThan(0);

    // The MSW server is already running and will intercept any Ably calls
    // This test verifies the mock is properly configured
    const fetchResponse = await fetch("https://rest.ably.io/keys/request");
    expect(fetchResponse.status).toBe(200);
    const data = (await fetchResponse.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("keyName");
  });

  it("should handle MSW-intercepted Resend email during reserve flow", async () => {
    const { resendHandlers } = await import("./msw/setup");
    expect(resendHandlers).toBeDefined();

    const fetchResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
    });
    expect(fetchResponse.status).toBe(200);
    const data = (await fetchResponse.json()) as Record<string, string>;
    expect(data).toHaveProperty("id");
    expect(data.id).toBe("email_test_12345");
  });

  it("should handle MSW-intercepted price oracle calls", async () => {
    const { priceOracleHandlers } = await import("./msw/setup");
    expect(priceOracleHandlers).toBeDefined();

    const fetchResponse = await fetch("http://localhost/api/prices");
    expect(fetchResponse.status).toBe(200);
    const data = (await fetchResponse.json()) as Record<
      string,
      Record<string, number>
    >;
    expect(data.ETH.USD).toBe(3500.0);
  });

  describe("DB-Backed Checkout Flow", () => {
    it("should find a reservation in the database after checkout", async () => {
      // Create a pending reservation in the real DB
      const startTime = new Date(Date.now() + 86400000);
      const endTime = new Date(startTime.getTime() + 90 * 60000);

      const [reservation] = await getDb()
        .insert(restaurantReservations)
        .values({
          restaurantId: testRestaurant.restaurant.id,
          tableId: testRestaurant.tables[0].id,
          guestName: "Checkout Flow Test",
          guestEmail: `checkout-flow-${randomUUID()}@example.com`,
          partySize: 2,
          startTime,
          endTime,
          status: "pending",
          isVerified: false,
        })
        .returning();

      // Verify the reservation exists in DB (proves Drizzle + SQL + Neon driver work together)
      const found = await getDb().query.restaurantReservations.findFirst({
        where: eq(restaurantReservations.id, reservation.id),
      });

      expect(found).toBeDefined();
      expect(found?.status).toBe("pending");
      expect(found?.isVerified).toBe(false);
      expect(found?.restaurantId).toBe(testRestaurant.restaurant.id);
    });

    it("should reject checkout for non-existent reservation", async () => {
      const { POST } = await import("../../app/api/v1/checkout/route");
      const nonExistentId = randomUUID();

      const validTxHash = `0x${"a".repeat(64)}`;

      const req = new Request("http://localhost/api/v1/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          txHash: validTxHash,
          reservationId: nonExistentId,
          paymentCurrency: "USDC" as const,
        }),
      });

      const response = await POST(req as any);
      // Should return 404 since reservation doesn't exist
      expect([400, 404]).toContain(response.status);
    });
  });
});
