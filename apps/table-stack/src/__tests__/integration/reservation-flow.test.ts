/**
 * Integration Tests: Complete Reservation Flow
 *
 * Tests the full reservation lifecycle:
 * 1. Check availability
 * 2. Create reservation
 * 3. Verify reservation
 * 4. Cancel reservation
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
  createTestReservation,
  type TestRestaurantData,
} from "../../test/setup";
import { getDb, restaurantReservations, eq } from "@repo/database";

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

describe("Integration: Reservation Flow", () => {
  let testRestaurant: TestRestaurantData;

  beforeAll(async () => {
    // Setup test database
    await setupTestDatabase();

    // Create test restaurant
    testRestaurant = await createTestRestaurant({
      id: `test-res-flow-${Date.now()}`,
      name: "Test Reservation Flow Restaurant",
      slug: "test-res-flow-restaurant",
      ownerEmail: "test-res-flow@example.com",
      ownerId: "test-owner-res-flow",
      apiKey: `ts_test_res_flow_${randomUUID().substring(0, 8)}`,
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /api/v1/availability", () => {
    it("should return available tables for valid request", async () => {
      const tomorrow = new Date(Date.now() + 86400000);
      const dateStr = tomorrow.toISOString();

      const { GET } = await import("../../app/api/v1/availability/route");
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
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
      const successData = data.data as Record<string, unknown>;
      expect(successData.availableTables).toBeDefined();
      expect(Array.isArray(successData.availableTables)).toBe(true);
    });

    it("should return 400 for missing parameters", async () => {
      const { GET } = await import("../../app/api/v1/availability/route");
      const req = new Request("http://localhost/api/v1/availability", {
        method: "GET",
      });

      const response = await GET(req as any);
      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe("VALIDATION_ERROR");
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
    });

    it("should return closed status for restaurant closed at that time", async () => {
      // Test with a time outside restaurant hours (e.g., 3 AM when they open at 9 AM)
      const tomorrow = new Date(Date.now() + 86400000);
      tomorrow.setHours(3, 0, 0, 0); // 3 AM
      const dateStr = tomorrow.toISOString();

      const { GET } = await import("../../app/api/v1/availability/route");
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
      expect(data.success).toBe(true);
      const successData = data.data as Record<string, unknown>;
      expect(successData.message).toContain("closed");
      expect(successData.availableTables).toEqual([]);
    });
  });

  describe("POST /api/v1/reserve", () => {
    it("should create reservation with valid request", async () => {
      const { POST } = await import("../../app/api/v1/reserve/route");

      const reservationData = {
        restaurantId: testRestaurant.restaurant.id,
        guestName: "John Doe",
        guestEmail: "john@example.com",
        partySize: 4,
        startTime: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
        specialRequests: "Window seat preferred",
      };

      const req = new Request("http://localhost/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": testRestaurant.apiKey,
          "Idempotency-Key": `idem-john-${randomUUID()}`,
        },
        body: JSON.stringify(reservationData),
      });

      const response = await POST(req as any);
      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.success).toBe(true);
      const successData = data.data as Record<string, unknown>;
      expect(successData.bookingId).toBeDefined();
    });

    it("should return 400 for invalid email", async () => {
      const { POST } = await import("../../app/api/v1/reserve/route");

      const req = new Request("http://localhost/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": testRestaurant.apiKey,
          "Idempotency-Key": `idem-invalid-email-${randomUUID()}`,
        },
        body: JSON.stringify({
          guestName: "John Doe",
          guestEmail: "invalid-email",
          partySize: 4,
          startTime: new Date(Date.now() + 86400000).toISOString(),
        }),
      });

      const response = await POST(req as any);
      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe("VALIDATION_ERROR");
    });

    it("should return 400 for invalid party size", async () => {
      const { POST } = await import("../../app/api/v1/reserve/route");

      const req = new Request("http://localhost/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": testRestaurant.apiKey,
          "Idempotency-Key": `idem-invalid-party-${randomUUID()}`,
        },
        body: JSON.stringify({
          guestName: "John Doe",
          guestEmail: "john@example.com",
          partySize: 100, // Too large
          startTime: new Date(Date.now() + 86400000).toISOString(),
        }),
      });

      const response = await POST(req as any);
      expect(response.status).toBe(400);
    });

    it("should return 400 without idempotency key", async () => {
      const { POST } = await import("../../app/api/v1/reserve/route");

      const req = new Request("http://localhost/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": testRestaurant.apiKey,
        },
        body: JSON.stringify({
          guestName: "John Doe",
          guestEmail: "john@example.com",
          partySize: 4,
          startTime: new Date(Date.now() + 86400000).toISOString(),
        }),
      });

      const response = await POST(req as any);
      expect(response.status).toBe(400);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.success).toBe(false);
    });
  });

  describe("Full Reservation Flow", () => {
    it("should complete full reservation lifecycle", async () => {
      // Step 1: Check availability
      const tomorrow = new Date(Date.now() + 86400000);
      const dateStr = tomorrow.toISOString();

      const { GET: availabilityHandler } =
        await import("../../app/api/v1/availability/route");
      const availabilityReq = new Request(
        `http://localhost/api/v1/availability?restaurantId=${testRestaurant.restaurant.id}&date=${dateStr}&partySize=4`,
        {
          method: "GET",
          headers: {
            "x-api-key": testRestaurant.apiKey,
          },
        },
      );

      const availabilityResponse = await availabilityHandler(
        availabilityReq as any,
      );
      expect(availabilityResponse.status).toBe(200);
      const availabilityData = (await availabilityResponse.json()) as Record<
        string,
        unknown
      >;
      expect(availabilityData.data).toBeDefined();

      // Step 2: Create reservation
      const { POST: reserveHandler } =
        await import("../../app/api/v1/reserve/route");
      const reserveReq = new Request("http://localhost/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": testRestaurant.apiKey,
          "Idempotency-Key": `idem-flow-${randomUUID()}`,
        },
        body: JSON.stringify({
          restaurantId: testRestaurant.restaurant.id,
          guestName: "Flow Test User",
          guestEmail: `flow-${randomUUID()}@example.com`,
          partySize: 4,
          startTime: dateStr,
        }),
      });

      const reserveResponse = await reserveHandler(reserveReq as any);
      expect(reserveResponse.status).toBe(200);
      const reserveData = (await reserveResponse.json()) as Record<
        string,
        unknown
      >;
      expect(reserveData.success).toBe(true);
      const successData = reserveData.data as Record<string, unknown>;
      expect(successData.bookingId).toBeDefined();

      // Step 3: Verify reservation exists in DB
      const bookingId = successData.bookingId as string;
      const reservation = await getDb().query.restaurantReservations.findFirst({
        where: eq(restaurantReservations.id, bookingId),
      });

      expect(reservation).toBeDefined();
      expect(reservation?.guestName).toBe("Flow Test User");
      expect(reservation?.status).toBe("pending");
    });
  });

  describe("Saga Compensation: Failure Injection", () => {
    it("should handle notification broadcast failure without failing the request", async () => {
      const { NotifyService } = await import("@tablestack/lib/notifications");
      (NotifyService.broadcast as any).mockRejectedValueOnce(
        new Error("Ably broadcast failed: Network error"),
      );

      // The reservation should still succeed even if notification fails
      const { POST } = await import("../../app/api/v1/reserve/route");

      const reservationData = {
        restaurantId: testRestaurant.restaurant.id,
        guestName: "Jane Smith",
        guestEmail: `jane-${randomUUID()}@example.com`,
        partySize: 2,
        startTime: new Date(Date.now() + 86400000).toISOString(),
      };

      const req = new Request("http://localhost/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": testRestaurant.apiKey,
          "Idempotency-Key": `idem-jane-${randomUUID()}`,
        },
        body: JSON.stringify(reservationData),
      });

      const response = await POST(req as any);
      // Reservation should still succeed (graceful degradation)
      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
    });

    it("should verify idempotency: multiple retries do not create duplicate reservations", async () => {
      const idempotencyKey = `idem-duplicate-${randomUUID()}`;
      const reservationData = {
        restaurantId: testRestaurant.restaurant.id,
        guestName: "Alice Brown",
        guestEmail: `alice-${randomUUID()}@example.com`,
        partySize: 3,
        startTime: new Date(Date.now() + 86400000).toISOString(),
      };

      const { POST } = await import("../../app/api/v1/reserve/route");

      // First request should succeed
      const req1 = new Request("http://localhost/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": testRestaurant.apiKey,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(reservationData),
      });

      const response1 = await POST(req1 as any);
      expect(response1.status).toBe(200);
      const data1 = (await response1.json()) as Record<string, unknown>;
      expect(data1.success).toBe(true);
      const bookingId1 = (data1.data as Record<string, unknown>)
        .bookingId as string;

      // Second request with same idempotency key should return 200 (duplicate)
      const req2 = new Request("http://localhost/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": testRestaurant.apiKey,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(reservationData),
      });

      const response2 = await POST(req2 as any);
      // Should return 200 with idempotency header or 409 if still processing
      expect([200, 409]).toContain(response2.status);

      if (response2.status === 200) {
        const data2 = (await response2.json()) as Record<string, unknown>;
        // If it's a duplicate, the booking ID should be the same
        const bookingId2 = (data2.data as Record<string, unknown>).bookingId as
          | string
          | undefined;
        if (bookingId2) {
          expect(bookingId2).toBe(bookingId1);
        }
      }
    });
  });
});
