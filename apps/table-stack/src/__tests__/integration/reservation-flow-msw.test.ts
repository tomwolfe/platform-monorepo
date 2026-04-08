/**
 * Integration Test: Reservation Flow with MSW
 *
 * Tests the full reservation lifecycle using MSW for API-level mocking.
 * This replaces module-level mocking with realistic HTTP-level mocks.
 *
 * @see Phase 2.2: Improve Mocking Strategy
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { server, startMocks, stopMocks, closeMocks } from "../../mocks/server";

describe("Integration: Reservation Flow (MSW)", () => {
  beforeAll(() => startMocks());
  afterAll(() => closeMocks());
  beforeEach(() => stopMocks());

  describe("GET /api/v1/restaurant", () => {
    it("should return restaurant for valid slug", async () => {
      const response = await fetch(
        "http://localhost:3000/api/v1/restaurant?slug=test-restaurant",
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.slug).toBe("test-restaurant");
      expect(data.name).toBe("Test Restaurant");
    });

    it("should return 404 for non-existent restaurant", async () => {
      const response = await fetch(
        "http://localhost:3000/api/v1/restaurant?slug=nonexistent",
      );

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe("NOT_FOUND");
    });
  });

  describe("GET /api/v1/availability", () => {
    it("should return available tables for valid request", async () => {
      const response = await fetch(
        "http://localhost:3000/api/v1/availability?restaurantId=mock-restaurant-id&date=2024-01-15T19:00:00Z&partySize=4",
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data.availableTables).toBeDefined();
      expect(data.data.availableTables.length).toBeGreaterThan(0);
    });

    it("should return 400 for missing parameters", async () => {
      const response = await fetch("http://localhost:3000/api/v1/availability");

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /api/v1/reserve", () => {
    it("should create reservation with valid request", async () => {
      const reservationData = {
        restaurantId: "mock-restaurant-id",
        guestName: "John Doe",
        guestEmail: "john@example.com",
        partySize: 4,
        startTime: "2024-01-15T19:00:00Z",
      };

      const response = await fetch("http://localhost:3000/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "ts_test_key",
        },
        body: JSON.stringify(reservationData),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data?.bookingId).toBe("booking-123");
    });

    it("should return 400 for invalid email", async () => {
      const response = await fetch("http://localhost:3000/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "ts_test_key",
        },
        body: JSON.stringify({
          guestName: "John Doe",
          guestEmail: "invalid-email",
          partySize: 4,
          startTime: "2024-01-15T19:00:00Z",
        }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe("VALIDATION_ERROR");
    });

    it("should return 401 without API key", async () => {
      const response = await fetch("http://localhost:3000/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          guestName: "John Doe",
          guestEmail: "john@example.com",
          partySize: 4,
          startTime: "2024-01-15T19:00:00Z",
        }),
      });

      expect(response.status).toBe(401);
    });

    it("should return 400 for invalid party size", async () => {
      const response = await fetch("http://localhost:3000/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "ts_test_key",
        },
        body: JSON.stringify({
          guestName: "John Doe",
          guestEmail: "john@example.com",
          partySize: 100,
          startTime: "2024-01-15T19:00:00Z",
        }),
      });

      expect(response.status).toBe(400);
    });
  });

  describe("Full Reservation Flow", () => {
    it("should complete full reservation lifecycle", async () => {
      // Step 1: Check availability
      const availabilityRes = await fetch(
        "http://localhost:3000/api/v1/availability?restaurantId=mock-restaurant-id&date=2024-01-15T19:00:00Z&partySize=4",
      );
      expect(availabilityRes.status).toBe(200);
      const availabilityData = await availabilityRes.json();
      expect(availabilityData.data.availableTables.length).toBeGreaterThan(0);

      // Step 2: Create reservation
      const reserveRes = await fetch("http://localhost:3000/api/v1/reserve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "ts_test_key",
        },
        body: JSON.stringify({
          restaurantId: "mock-restaurant-id",
          guestName: "John Doe",
          guestEmail: "john@example.com",
          partySize: 4,
          startTime: "2024-01-15T19:00:00Z",
        }),
      });
      expect(reserveRes.status).toBe(200);
      const reserveData = await reserveRes.json();
      expect(reserveData.data?.bookingId).toBe("booking-123");

      // Step 3: Verify reservation
      const verifyRes = await fetch(
        "http://localhost:3000/api/v1/verify?token=token-abc",
      );
      expect(verifyRes.status).toBe(200);
      const verifyData = await verifyRes.json();
      expect(verifyData.data.verified).toBe(true);
    });
  });
});
