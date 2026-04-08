/**
 * MSW Handlers for API-level Mocking
 *
 * Provides realistic API mocks for integration tests.
 * Replaces module-level mocking with actual HTTP-level mocking.
 *
 * @see Phase 2.2: Improve Mocking Strategy
 */

import { http, HttpResponse } from "msw";

// ============================================================================
// MOCK DATA
// ============================================================================

const mockRestaurant = {
  id: "mock-restaurant-id",
  name: "Test Restaurant",
  slug: "test-restaurant",
  ownerEmail: "owner@test.com",
  ownerId: "owner-123",
  apiKey: "ts_test_key",
  timezone: "America/New_York",
  openingTime: "09:00",
  closingTime: "22:00",
  daysOpen: "monday,tuesday,wednesday,thursday,friday,saturday,sunday",
  defaultDurationMinutes: 90,
};

const mockTables = [
  {
    id: "table-1",
    tableNumber: "1",
    minCapacity: 2,
    maxCapacity: 4,
    xPos: 50,
    yPos: 50,
    status: "vacant",
    tableType: "square",
  },
  {
    id: "table-2",
    tableNumber: "2",
    minCapacity: 4,
    maxCapacity: 6,
    xPos: 150,
    yPos: 50,
    status: "vacant",
    tableType: "round",
  },
];

// ============================================================================
// HANDLERS
// ============================================================================

export const handlers = [
  // GET /api/v1/restaurant
  http.get("http://localhost:3000/api/v1/restaurant", ({ request }) => {
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");

    if (slug === "test-restaurant" || slug === "demo") {
      return HttpResponse.json(mockRestaurant);
    }

    return HttpResponse.json(
      {
        success: false,
        error: { code: "NOT_FOUND", message: "Restaurant not found" },
      },
      { status: 404 },
    );
  }),

  // GET /api/v1/availability
  http.get("http://localhost:3000/api/v1/availability", ({ request }) => {
    const url = new URL(request.url);
    const restaurantId = url.searchParams.get("restaurantId");
    const date = url.searchParams.get("date");
    const partySize = url.searchParams.get("partySize");

    if (!restaurantId || !date || !partySize) {
      return HttpResponse.json(
        {
          success: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Missing required parameters",
          },
        },
        { status: 400 },
      );
    }

    return HttpResponse.json({
      success: true,
      data: {
        availableTables: mockTables,
        suggestedSlots: [],
      },
    });
  }),

  // POST /api/v1/reserve
  http.post("http://localhost:3000/api/v1/reserve", async ({ request }) => {
    const apiKey = request.headers.get("x-api-key");

    if (!apiKey) {
      return HttpResponse.json(
        {
          success: false,
          error: { code: "UNAUTHORIZED", message: "API key required" },
        },
        { status: 401 },
      );
    }

    const body = await request.json();
    const parsed = body as Record<string, unknown>;

    // Validate email
    if (
      typeof parsed.guestEmail !== "string" ||
      !parsed.guestEmail.includes("@")
    ) {
      return HttpResponse.json(
        {
          success: false,
          error: { code: "VALIDATION_ERROR", message: "Invalid email address" },
        },
        { status: 400 },
      );
    }

    // Validate party size
    if (
      typeof parsed.partySize !== "number" ||
      parsed.partySize < 1 ||
      parsed.partySize > 20
    ) {
      return HttpResponse.json(
        {
          success: false,
          error: { code: "VALIDATION_ERROR", message: "Invalid party size" },
        },
        { status: 400 },
      );
    }

    return HttpResponse.json({
      success: true,
      data: {
        bookingId: "booking-123",
        verificationToken: "token-abc",
        message:
          "Reservation created successfully. Please check your email for verification.",
      },
    });
  }),

  // GET /api/v1/verify
  http.get("http://localhost:3000/api/v1/verify", ({ request }) => {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return HttpResponse.json(
        {
          success: false,
          error: { code: "VALIDATION_ERROR", message: "Token required" },
        },
        { status: 400 },
      );
    }

    return HttpResponse.json({
      success: true,
      data: {
        verified: true,
        reservationId: "booking-123",
      },
    });
  }),

  // POST /api/v1/verify
  http.post("http://localhost:3000/api/v1/verify", async ({ request }) => {
    const body = await request.json();
    const parsed = body as { token?: string };

    if (!parsed.token) {
      return HttpResponse.json(
        {
          success: false,
          error: { code: "VALIDATION_ERROR", message: "Token required" },
        },
        { status: 400 },
      );
    }

    return HttpResponse.json({
      success: true,
      data: {
        verified: true,
        reservationId: "booking-123",
      },
    });
  }),
];
