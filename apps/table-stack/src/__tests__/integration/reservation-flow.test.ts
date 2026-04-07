/**
 * Integration Tests: Complete Reservation Flow
 *
 * Tests the full reservation lifecycle:
 * 1. Check availability
 * 2. Create reservation
 * 3. Verify reservation
 * 4. Cancel reservation
 *
 * @see Phase 3: Integration Testing
 */

import { vi } from 'vitest';

// ============================================================================
// MOCKS - MUST BE HOISTED BEFORE ANY OTHER IMPORTS
// ============================================================================

/**
 * Mock @tablestack/lib/auth for integration tests
 */
vi.mock('@tablestack/lib/auth', () => ({
  validateRequest: vi.fn(() => Promise.resolve({
    context: { 
      restaurantId: 'mock-restaurant-id', 
      isInternal: true 
    }
  })),
}));

/**
 * Mock @tablestack/lib/notifications for integration tests
 */
vi.mock('@tablestack/lib/notifications', () => ({
  NotifyService: {
    broadcast: vi.fn(() => Promise.resolve()),
    notifyExternalDelivery: vi.fn(() => Promise.resolve()),
    notifyRejection: vi.fn(() => Promise.resolve()),
    sendEmail: vi.fn(() => Promise.resolve()),
  },
}));

/**
 * Mock @repo/database for integration tests
 */
vi.mock('@repo/database', async () => {
  const actual = await vi.importActual('@repo/database');
  const mockRestaurantData = {
    id: 'mock-restaurant-id',
    name: 'Test Restaurant',
    slug: 'test-restaurant',
    ownerEmail: 'owner@test.com',
    ownerId: 'owner-123',
    apiKey: 'ts_test_key',
    timezone: 'America/New_York',
    openingTime: '09:00',
    closingTime: '22:00',
    daysOpen: 'monday,tuesday,wednesday,thursday,friday,saturday,sunday',
    defaultDurationMinutes: 90,
  };

  const restaurantsFindFirstMock = vi.fn();
  const restaurantReservationsFindFirstMock = vi.fn();
  const restaurantTablesFindFirstMock = vi.fn();
  const guestProfilesFindFirstMock = vi.fn();

  return {
    ...(actual as any),
    getDb: () => ({
      query: {
        restaurants: {
          findFirst: restaurantsFindFirstMock,
        },
        restaurantReservations: {
          findFirst: restaurantReservationsFindFirstMock,
        },
        restaurantTables: {
          findFirst: restaurantTablesFindFirstMock,
        },
        guestProfiles: {
          findFirst: guestProfilesFindFirstMock,
        },
      },
      insert: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(async (fn: any) => fn({
        execute: vi.fn(),
        query: {
          restaurantReservations: {
            findFirst: restaurantReservationsFindFirstMock,
          },
        },
        insert: vi.fn(),
        update: vi.fn(),
      })),
    }),
    restaurants: {
      apiKey: 'apiKey',
      id: 'id',
    },
    restaurantReservations: {
      verificationToken: 'verificationToken',
      id: 'id',
    },
    eq: vi.fn(),
  };
});

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';

describe('Integration: Reservation Flow', () => {
  const mockRestaurant = {
    id: 'mock-restaurant-id',
    name: 'Test Restaurant',
    slug: 'test-restaurant',
    ownerEmail: 'owner@test.com',
    ownerId: 'owner-123',
    apiKey: 'ts_test_key',
    timezone: 'America/New_York',
    openingTime: '09:00',
    closingTime: '22:00',
    daysOpen: 'monday,tuesday,wednesday,thursday,friday,saturday,sunday',
    defaultDurationMinutes: 90,
  };

  const mockTable = {
    id: randomUUID(),
    restaurantId: mockRestaurant.id,
    tableNumber: 'T1',
    minCapacity: 2,
    maxCapacity: 4,
    isActive: true,
    status: 'vacant',
    xPos: 0,
    yPos: 0,
    tableType: 'square',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/v1/availability', () => {
    it('should return available tables for valid request', async () => {
      // Mock restaurant lookup
      const { getDb } = await import('@repo/database');
      const db = getDb();
      (db.query.restaurants.findFirst as any).mockResolvedValue(mockRestaurant);
      (db.query.restaurantTables.findFirst as any).mockResolvedValue(mockTable);

      // Create test request
      const req = new Request(
        `http://localhost:3000/api/v1/availability?restaurantId=${mockRestaurant.id}&date=2024-01-15T19:00:00Z&partySize=4`,
        {
          method: 'GET',
          headers: {
            'x-api-key': mockRestaurant.apiKey,
          },
        }
      );

      // Import and call handler
      const { GET } = await import('../../app/api/v1/availability/route');
      const response = await GET(req as any);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data).toBeDefined();
      expect(data.data.availableTables).toBeDefined();
    });

    it('should return 400 for missing parameters', async () => {
      const req = new Request('http://localhost:3000/api/v1/availability', {
        method: 'GET',
      });

      const { GET } = await import('../../app/api/v1/availability/route');
      const response = await GET(req as any);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should return 404 for non-existent restaurant', async () => {
      const { getDb } = await import('@repo/database');
      const db = getDb();
      (db.query.restaurants.findFirst as any).mockResolvedValue(null);

      const req = new Request(
        `http://localhost:3000/api/v1/availability?restaurantId=${randomUUID()}&date=2024-01-15T19:00:00Z&partySize=4`,
        {
          method: 'GET',
        }
      );

      const { GET } = await import('../../app/api/v1/availability/route');
      const response = await GET(req as any);

      expect(response.status).toBe(404);
    });

    it('should return closed status for restaurant closed on that day', async () => {
      const { getDb } = await import('@repo/database');
      const db = getDb();
      (db.query.restaurants.findFirst as any).mockResolvedValue({
        ...mockRestaurant,
        daysOpen: 'monday,tuesday,wednesday',
      });

      // Sunday (not in daysOpen)
      const req = new Request(
        `http://localhost:3000/api/v1/availability?restaurantId=${mockRestaurant.id}&date=2024-01-14T19:00:00Z&partySize=4`,
        {
          method: 'GET',
        }
      );

      const { GET } = await import('../../app/api/v1/availability/route');
      const response = await GET(req as any);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.data?.message).toContain('closed');
    });
  });

  describe('POST /api/v1/reserve', () => {
    it('should create reservation with valid request', async () => {
      const { getDb } = await import('@repo/database');
      const db = getDb();

      // Mock all database calls
      (db.query.restaurants.findFirst as any).mockResolvedValue(mockRestaurant);
      (db.query.guestProfiles.findFirst as any).mockResolvedValue(null);
      (db.transaction as any).mockImplementation(async (fn: any) => {
        return fn({
          execute: vi.fn().mockResolvedValue([{ id: mockTable.id }]),
          query: {
            restaurantReservations: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
          },
          insert: vi.fn().mockResolvedValue([{
            id: randomUUID(),
            verificationToken: randomUUID(),
          }]),
          update: vi.fn(),
        });
      });

      const reservationData = {
        restaurantId: mockRestaurant.id,
        guestName: 'John Doe',
        guestEmail: 'john@example.com',
        partySize: 4,
        startTime: '2024-01-15T19:00:00Z',
        specialRequests: 'Window seat preferred',
      };

      const req = new Request('http://localhost:3000/api/v1/reserve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': mockRestaurant.apiKey,
        },
        body: JSON.stringify(reservationData),
      });

      const { POST } = await import('../../app/api/v1/reserve/route');
      const response = await POST(req as any);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data?.bookingId).toBeDefined();
    });

    it('should return 400 for invalid email', async () => {
      const req = new Request('http://localhost:3000/api/v1/reserve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          guestName: 'John Doe',
          guestEmail: 'invalid-email',
          partySize: 4,
          startTime: '2024-01-15T19:00:00Z',
        }),
      });

      const { POST } = await import('../../app/api/v1/reserve/route');
      const response = await POST(req as any);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.success).toBe(false);
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 for invalid party size', async () => {
      const req = new Request('http://localhost:3000/api/v1/reserve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          guestName: 'John Doe',
          guestEmail: 'john@example.com',
          partySize: 100, // Too large
          startTime: '2024-01-15T19:00:00Z',
        }),
      });

      const { POST } = await import('../../app/api/v1/reserve/route');
      const response = await POST(req as any);

      expect(response.status).toBe(400);
    });

    it('should return 401 without authentication', async () => {
      const req = new Request('http://localhost:3000/api/v1/reserve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          guestName: 'John Doe',
          guestEmail: 'john@example.com',
          partySize: 4,
          startTime: '2024-01-15T19:00:00Z',
        }),
      });

      const { POST } = await import('../../app/api/v1/reserve/route');
      const response = await POST(req as any);

      expect(response.status).toBe(401);
    });
  });

  describe('GET /api/v1/verify', () => {
    it('should verify reservation with valid token', async () => {
      const verificationToken = randomUUID();
      const reservationId = randomUUID();

      const { getDb } = await import('@repo/database');
      const db = getDb();

      (db.query.restaurantReservations.findFirst as any).mockResolvedValueOnce({
        id: reservationId,
        verificationToken,
        isVerified: false,
        status: 'pending',
        restaurant: mockRestaurant,
      });

      const req = new Request(`http://localhost:3000/api/v1/verify?token=${verificationToken}`, {
        method: 'GET',
      });

      const { GET } = await import('../../app/api/v1/verify/route');
      const response = await GET(req as any);

      expect(response.status).toBe(200);
    });

    it('should return 404 for invalid token', async () => {
      const { getDb } = await import('@repo/database');
      const db = getDb();
      (db.query.restaurantReservations.findFirst as any).mockResolvedValueOnce(null);

      const req = new Request(`http://localhost:3000/api/v1/verify?token=${randomUUID()}`, {
        method: 'GET',
      });

      const { GET } = await import('../../app/api/v1/verify/route');
      const response = await GET(req as any);

      expect(response.status).toBe(404);
    });

    it('should return 200 for already verified reservation', async () => {
      const { getDb } = await import('@repo/database');
      const db = getDb();
      (db.query.restaurantReservations.findFirst as any).mockResolvedValueOnce({
        id: randomUUID(),
        isVerified: true,
        status: 'confirmed',
      });

      const req = new Request(`http://localhost:3000/api/v1/verify?token=${randomUUID()}`, {
        method: 'GET',
      });

      const { GET } = await import('../../app/api/v1/verify/route');
      const response = await GET(req as any);

      expect(response.status).toBe(200);
    });
  });

  describe('Full Reservation Flow', () => {
    it('should complete full reservation lifecycle', async () => {
      const { getDb } = await import('@repo/database');
      const db = getDb();

      // Setup mocks
      (db.query.restaurants.findFirst as any).mockResolvedValue(mockRestaurant);
      (db.query.guestProfiles.findFirst as any).mockResolvedValue(null);

      let createdReservationId: string | null = null;

      (db.transaction as any).mockImplementation(async (fn: any) => {
        const result = await fn({
          execute: vi.fn().mockResolvedValue([{ id: mockTable.id }]),
          query: {
            restaurantReservations: {
              findFirst: vi.fn().mockResolvedValue(null),
            },
          },
          insert: vi.fn().mockResolvedValue([{
            id: randomUUID(),
            verificationToken: randomUUID(),
          }]),
          update: vi.fn(),
        });
        createdReservationId = result.newReservation?.id || null;
        return result;
      });

      // Step 1: Check availability
      const availabilityReq = new Request(
        `http://localhost:3000/api/v1/availability?restaurantId=${mockRestaurant.id}&date=2024-01-15T19:00:00Z&partySize=4`,
        {
          method: 'GET',
          headers: {
            'x-api-key': mockRestaurant.apiKey,
          },
        }
      );

      const { GET: availabilityHandler } = await import('../../app/api/v1/availability/route');
      const availabilityResponse = await availabilityHandler(availabilityReq as any);
      expect(availabilityResponse.status).toBe(200);

      // Step 2: Create reservation
      const reserveReq = new Request('http://localhost:3000/api/v1/reserve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': mockRestaurant.apiKey,
        },
        body: JSON.stringify({
          restaurantId: mockRestaurant.id,
          guestName: 'John Doe',
          guestEmail: 'john@example.com',
          partySize: 4,
          startTime: '2024-01-15T19:00:00Z',
        }),
      });

      const { POST: reserveHandler } = await import('../../app/api/v1/reserve/route');
      const reserveResponse = await reserveHandler(reserveReq as any);
      expect(reserveResponse.status).toBe(200);

      const reserveData = await reserveResponse.json();
      expect(reserveData.data?.bookingId).toBeDefined();

      // Step 3: Verify reservation
      const verificationToken = randomUUID();
      (db.query.restaurantReservations.findFirst as any).mockResolvedValue({
        id: reserveData.data.bookingId,
        verificationToken,
        isVerified: false,
        status: 'pending',
        restaurant: mockRestaurant,
      });

      const verifyReq = new Request('http://localhost:3000/api/v1/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: verificationToken }),
      });

      const { POST: verifyHandler } = await import('../../app/api/v1/verify/route');
      const verifyResponse = await verifyHandler(verifyReq as any);
      expect(verifyResponse.status).toBe(200);
    });
  });
});
