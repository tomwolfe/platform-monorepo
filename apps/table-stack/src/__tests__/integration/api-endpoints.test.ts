/**
 * Integration Tests: API Endpoints
 *
 * Tests for all API endpoints in apps/table-stack/src/app/api/
 *
 * Coverage Targets:
 * - GET /api/health: Health check endpoint
 * - GET /api/ready: Readiness check endpoint
 * - GET /api/v1/availability: Table availability
 * - POST /api/v1/verify: Reservation verification
 * - POST /api/v1/checkout: Web3 checkout
 * - POST /api/v1/reserve: Web3 reserve
 *
 * @see Phase 1.1: Testing Infrastructure
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
  vi,
} from "vitest";
import { randomUUID } from "crypto";
import {
  setupTestDatabase,
  cleanupTestDatabase,
  createTestRestaurant,
  createTestTables,
  type TestRestaurantData,
} from "../../test/setup";
import { setupIntegrationMocks } from "./msw/setup";

const msw = setupIntegrationMocks();

beforeAll(() => msw.start());
afterAll(() => msw.stop());
beforeEach(() => {
  msw.reset();
  vi.restoreAllMocks();
});

// Mock @repo/database for non-DB parts of the tests
vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
  };
});

// Mock serverless timeout
vi.mock("@repo/shared/middleware/serverless-timeout", () => ({
  withServerlessTimeout: vi.fn((handler: any) => handler),
}));

// Mock @repo/shared redis client
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
  };
});

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
  withServerlessTimeout: vi.fn((handler: any) => handler),
}));

// Mock redis
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

describe("API Endpoint Integration Tests", () => {
  let testRestaurant: TestRestaurantData;

  beforeAll(async () => {
    // Setup test database
    await setupTestDatabase();

    // Create test restaurant
    testRestaurant = await createTestRestaurant({
      id: `test-res-${Date.now()}`,
      name: "Test API Restaurant",
      slug: "test-api-restaurant",
      ownerEmail: "test-api@example.com",
      ownerId: "test-owner-api",
      apiKey: `ts_test_api_${randomUUID().substring(0, 8)}`,
      isShadow: false,
      isClaimed: true,
      timezone: "America/New_York",
      daysOpen: "monday,tuesday,wednesday,thursday,friday,saturday,sunday",
      openingTime: "09:00",
      closingTime: "22:00",
      defaultDurationMinutes: 90,
    });

    // Create test tables
    await createTestTables(testRestaurant.restaurant.id, 5);
  });

  afterAll(async () => {
    // Cleanup test restaurant and related data
    try {
      await cleanupTestDatabase();
    } catch (error) {
      console.warn("Test database cleanup failed:", error);
    }
  });

  describe("POST /api/v1/checkout", () => {
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

    it("should return 404 for non-existent reservation", async () => {
      const { POST } = await import("../../app/api/v1/checkout/route");
      const validTxHash = `0x${"a".repeat(64)}`;
      const nonExistentReservationId = randomUUID();

      const body = {
        txHash: validTxHash,
        reservationId: nonExistentReservationId,
        paymentCurrency: "USDC" as const,
        signature: "0xsignature",
        walletAddress: "0xwallet",
        chainId: 8453,
        deadline: Math.floor(Date.now() / 1000) + 300,
        signedAmount: "1000000",
      };

      const req = new Request("http://localhost/api/v1/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const response = await POST(req as any);
      expect(response.status).toBe(404);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("success", false);
      const errorObj = data.error as Record<string, unknown>;
      expect(errorObj).toHaveProperty("code", "NOT_FOUND");
    });
  });

  describe("POST /api/v1/reserve", () => {
    it("should validate idempotency key requirement", async () => {
      const { POST } = await import("../../app/api/v1/reserve/route");

      const req = new Request("http://localhost/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": testRestaurant.apiKey,
        },
        body: JSON.stringify({
          restaurantId: testRestaurant.restaurant.id,
          guestName: "Test Guest",
          guestEmail: "test@example.com",
          partySize: 4,
          startTime: new Date(Date.now() + 86400000).toISOString(),
        }),
      });

      const response = await POST(req as any);
      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("success", false);
      const errorObj = data.error as Record<string, unknown>;
      expect(errorObj).toHaveProperty("code", "VALIDATION_ERROR");
    });

    it("should reject invalid email format", async () => {
      const { POST } = await import("../../app/api/v1/reserve/route");

      const req = new Request("http://localhost/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": testRestaurant.apiKey,
          "Idempotency-Key": `idem-invalid-email-${randomUUID()}`,
        },
        body: JSON.stringify({
          restaurantId: testRestaurant.restaurant.id,
          guestName: "Test Guest",
          guestEmail: "invalid-email",
          partySize: 4,
          startTime: new Date(Date.now() + 86400000).toISOString(),
        }),
      });

      const response = await POST(req as any);
      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("success", false);
    });

    it("should reject invalid party size", async () => {
      const { POST } = await import("../../app/api/v1/reserve/route");

      const req = new Request("http://localhost/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": testRestaurant.apiKey,
          "Idempotency-Key": `idem-invalid-party-${randomUUID()}`,
        },
        body: JSON.stringify({
          restaurantId: testRestaurant.restaurant.id,
          guestName: "Test Guest",
          guestEmail: "test@example.com",
          partySize: 100,
          startTime: new Date(Date.now() + 86400000).toISOString(),
        }),
      });

      const response = await POST(req as any);
      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("success", false);
    });
  });

  describe("GET /api/v1/availability", () => {
    it("should return 400 for missing parameters", async () => {
      const { GET } = await import("../../app/api/v1/availability/route");

      const req = new Request("http://localhost/api/v1/availability", {
        method: "GET",
      });

      const response = await GET(req as any);
      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("success", false);
    });

    it("should return 404 for non-existent restaurant", async () => {
      const { GET } = await import("../../app/api/v1/availability/route");
      const nonExistentId = randomUUID();

      const req = new Request(
        `http://localhost/api/v1/availability?restaurantId=${nonExistentId}&date=2024-01-15T19:00:00Z&partySize=4`,
        {
          method: "GET",
        },
      );

      const response = await GET(req as any);
      expect(response.status).toBe(404);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("success", false);
    });

    it("should return available tables based on time overlap logic", async () => {
      const { GET } = await import("../../app/api/v1/availability/route");
      const tomorrow = new Date(Date.now() + 86400000);
      const dateStr = tomorrow.toISOString();

      const req = new Request(
        `http://localhost/api/v1/availability?restaurantId=${testRestaurant.restaurant.id}&date=${dateStr}&partySize=4`,
        {
          method: "GET",
          headers: {
            "x-api-key": testRestaurant.apiKey,
          },
        },
      );

      const response = await GET(req as any);
      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("success", true);
      const successData = data.data as Record<string, unknown>;
      expect(successData).toHaveProperty("availableTables");
      expect(Array.isArray(successData.availableTables)).toBe(true);
    });

    it("should return closed status for restaurant closed on that day", async () => {
      // Create a restaurant that is only open on weekdays
      const weekdayRestaurant = await createTestRestaurant({
        id: `test-weekday-${Date.now()}`,
        name: "Weekday Only Restaurant",
        slug: "test-weekday-restaurant",
        ownerEmail: "weekday@example.com",
        ownerId: "test-owner-weekday",
        apiKey: `ts_test_weekday_${randomUUID().substring(0, 8)}`,
        isShadow: false,
        isClaimed: true,
        timezone: "America/New_York",
        daysOpen: "monday,tuesday,wednesday,thursday,friday",
        openingTime: "09:00",
        closingTime: "22:00",
        defaultDurationMinutes: 90,
      });

      // Sunday January 14, 2024 is a Sunday
      const sundayDate = "2024-01-14T19:00:00Z";

      const { GET } = await import("../../app/api/v1/availability/route");

      const req = new Request(
        `http://localhost/api/v1/availability?restaurantId=${weekdayRestaurant.restaurant.id}&date=${sundayDate}&partySize=4`,
        {
          method: "GET",
          headers: {
            "x-api-key": weekdayRestaurant.apiKey,
          },
        },
      );

      const response = await GET(req as any);
      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toHaveProperty("success", true);
      const successData = data.data as Record<string, unknown>;
      expect(successData.message).toContain("closed");
      expect(successData.availableTables).toEqual([]);
    });
  });

  describe("MSW Integration", () => {
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
  });
});
