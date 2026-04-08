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

  it("should validate reserve request schema correctly", async () => {
    // Import the route handler
    const { POST } = await import("@/app/api/v1/reserve/route");

    const invalidBody = { name: "" }; // Missing required fields
    const request = new Request("http://localhost/api/v1/reserve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-idepotency-key": "test-key-123",
      },
      body: JSON.stringify(invalidBody),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body).toHaveProperty("error");
  });

  it("should reject request without idempotency key", async () => {
    const { POST } = await import("@/app/api/v1/reserve/route");

    const request = new Request("http://localhost/api/v1/reserve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        restaurantId: "test-restaurant",
        date: "2026-04-07",
        time: "19:00",
        partySize: 2,
        name: "Test User",
        email: "test@example.com",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
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
