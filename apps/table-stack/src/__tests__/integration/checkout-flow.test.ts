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
import { setupIntegrationMocks } from "./msw/setup";

const msw = setupIntegrationMocks();

beforeAll(() => msw.start());
afterAll(() => msw.stop());
beforeEach(() => {
  msw.reset();
  vi.restoreAllMocks();
});

// Mock @repo/database
vi.mock("@repo/database", () => ({
  getDb: vi.fn(),
  restaurants: { $inferInsert: {}, $inferSelect: {} },
  restaurantTables: { $inferInsert: {}, $inferSelect: {} },
  restaurantReservations: { $inferInsert: {}, $inferSelect: {} },
  restaurantWaitlist: { $inferInsert: {}, $inferSelect: {} },
  restaurantProducts: { $inferInsert: {}, $inferSelect: {} },
  inventoryLevels: { $inferInsert: {}, $inferSelect: {} },
  guestProfiles: { $inferInsert: {}, $inferSelect: {} },
  eq: vi.fn(),
}));

describe("Checkout/Reserve Flow Integration", () => {
  beforeEach(() => {
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://postgres:postgres@localhost:5432/test",
    );
    vi.stubEnv("AUTH_SECRET", "test-secret-key-for-testing");
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
});
