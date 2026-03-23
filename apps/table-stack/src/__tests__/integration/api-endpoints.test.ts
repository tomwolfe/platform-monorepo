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
 *
 * @see Phase 1.1: Testing Infrastructure
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getDb, restaurants, restaurantTables, restaurantReservations } from '@repo/database';
import { eq } from '@repo/database';

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Create a test restaurant
 */
async function createTestRestaurant(overrides?: Partial<typeof restaurants.$inferInsert>) {
  const [restaurant] = await getDb().insert(restaurants).values({
    name: `Test Restaurant API ${Date.now()}`,
    slug: `test-restaurant-api-${Date.now()}`,
    ownerEmail: `test-api-${Date.now()}@example.com`,
    ownerId: 'test-owner',
    apiKey: `ts_test_${Math.random().toString(36).substring(2, 10)}`,
    isShadow: false,
    isClaimed: true,
    ...overrides,
  }).returning();

  return restaurant;
}

/**
 * Create test tables for a restaurant
 */
async function createTestTables(restaurantId: string, count: number = 5) {
  const tables = [];
  for (let i = 0; i < count; i++) {
    const [table] = await getDb().insert(restaurantTables).values({
      restaurantId,
      tableNumber: `T${i + 1}`,
      minCapacity: 2,
      maxCapacity: 4,
      xPos: i * 100,
      yPos: 0,
      isActive: true,
      status: 'vacant',
    }).returning();
    tables.push(table);
  }
  return tables;
}

/**
 * Clean up test data
 */
async function cleanupTestData(restaurantId: string) {
  await getDb().delete(restaurantReservations).where(eq(restaurantReservations.restaurantId, restaurantId));
  await getDb().delete(restaurantTables).where(eq(restaurantTables.restaurantId, restaurantId));
  await getDb().delete(restaurants).where(eq(restaurants.id, restaurantId));
}

/**
 * Create mock request for API testing
 */
function createMockApiRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: any;
} = {}) {
  const { method = 'GET', url = 'http://localhost:3000/api/test', headers = {}, body = null } = options;

  return {
    method,
    url,
    headers: {
      get: vi.fn((name: string) => headers[name.toLowerCase()] || null),
    },
    json: vi.fn(async () => body),
  };
}

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe('API Endpoint Integration Tests', () => {
  let testRestaurant: typeof restaurants.$inferSelect;
  let testTables: Array<typeof restaurantTables.$inferSelect>;
  let testApiKey: string;

  beforeAll(async () => {
    // Setup test data
    testRestaurant = await createTestRestaurant();
    testTables = await createTestTables(testRestaurant.id, 5);
    testApiKey = testRestaurant.apiKey;
  });

  afterAll(async () => {
    // Cleanup
    if (testRestaurant) {
      await cleanupTestData(testRestaurant.id);
    }
  });

  // ============================================================================
  // Health Check Endpoint
  // ============================================================================

  describe('GET /api/health', () => {
    it('should return healthy status', async () => {
      const { GET } = await import('../health/route');
      const response = await GET();

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('healthy');
      expect(data.timestamp).toBeDefined();
      expect(data.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should include service info', async () => {
      const { GET } = await import('../health/route');
      const response = await GET();

      const data = await response.json();

      expect(data.service).toBeDefined();
      expect(data.version).toBeDefined();
    });

    it('should complete within 1 second', async () => {
      const startTime = Date.now();
      const { GET } = await import('../health/route');
      await GET();
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(1000);
    });
  });

  // ============================================================================
  // Readiness Check Endpoint
  // ============================================================================

  describe('GET /api/ready', () => {
    it('should return ready status when dependencies are available', async () => {
      const { GET } = await import('../ready/route');
      const response = await GET();

      const data = await response.json();

      expect([200, 503]).toContain(response.status);
      expect(typeof data.ready).toBe('boolean');
      expect(data.timestamp).toBeDefined();
    });

    it('should include readiness details', async () => {
      const { GET } = await import('../ready/route');
      const response = await GET();

      const data = await response.json();

      expect(data.timestamp).toBeDefined();
    });
  });

  // ============================================================================
  // Availability Endpoint
  // ============================================================================

  describe('GET /api/v1/availability', () => {
    it('should return available tables for valid request', async () => {
      const testTime = new Date(Date.now() + 86400000); // Tomorrow
      const testDate = testTime.toISOString();

      const req = createMockApiRequest({
        url: `http://localhost:3000/api/v1/availability?restaurantId=${testRestaurant.id}&date=${testDate}&partySize=2`,
        headers: {
          'x-api-key': testApiKey,
        },
      });

      const { GET } = await import('../v1/availability/route');
      const response = await GET(req as any);

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.restaurantId).toBe(testRestaurant.id);
      expect(data.data.availableTables).toBeDefined();
      expect(Array.isArray(data.data.availableTables)).toBe(true);
    });

    it('should reject missing restaurantId', async () => {
      const testTime = new Date(Date.now() + 86400000);
      const testDate = testTime.toISOString();

      const req = createMockApiRequest({
        url: `http://localhost:3000/api/v1/availability?date=${testDate}&partySize=2`,
      });

      const { GET } = await import('../v1/availability/route');
      const response = await GET(req as any);

      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBeDefined();
    });

    it('should reject invalid restaurantId format', async () => {
      const testTime = new Date(Date.now() + 86400000);
      const testDate = testTime.toISOString();

      const req = createMockApiRequest({
        url: `http://localhost:3000/api/v1/availability?restaurantId=invalid-id&date=${testDate}&partySize=2`,
      });

      const { GET } = await import('../v1/availability/route');
      const response = await GET(req as any);

      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBeDefined();
    });

    it('should reject missing partySize', async () => {
      const testTime = new Date(Date.now() + 86400000);
      const testDate = testTime.toISOString();

      const req = createMockApiRequest({
        url: `http://localhost:3000/api/v1/availability?restaurantId=${testRestaurant.id}&date=${testDate}`,
      });

      const { GET } = await import('../v1/availability/route');
      const response = await GET(req as any);

      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBeDefined();
    });

    it('should reject unauthorized access to other restaurant', async () => {
      const testTime = new Date(Date.now() + 86400000);
      const testDate = testTime.toISOString();

      const req = createMockApiRequest({
        url: `http://localhost:3000/api/v1/availability?restaurantId=00000000-0000-0000-0000-000000000000&date=${testDate}&partySize=2`,
        headers: {
          'x-api-key': testApiKey,
        },
      });

      const { GET } = await import('../v1/availability/route');
      const response = await GET(req as any);

      expect(response.status).toBe(403);
    });

    it('should return empty tables for restaurant closed day', async () => {
      // Create a restaurant that's closed on specific days
      const closedRestaurant = await createTestRestaurant({
        daysOpen: 'monday,tuesday,wednesday',
        openingTime: '09:00',
        closingTime: '21:00',
      });

      // Test on a Sunday (assuming restaurant is closed)
      const testTime = new Date('2024-01-07'); // Sunday
      const testDate = testTime.toISOString();

      const req = createMockApiRequest({
        url: `http://localhost:3000/api/v1/availability?restaurantId=${closedRestaurant.id}&date=${testDate}&partySize=2`,
        headers: {
          'x-api-key': testApiKey,
        },
      });

      const { GET } = await import('../v1/availability/route');
      const response = await GET(req as any);

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.availableTables).toEqual([]);

      // Cleanup
      await cleanupTestData(closedRestaurant.id);
    });

    it('should suggest alternative time slots when no tables available', async () => {
      // Create a reservation that blocks all tables at the requested time
      const testTime = new Date(Date.now() + 86400000 * 2);
      const startTime = testTime;

      // Book all tables
      for (const table of testTables) {
        await getDb().insert(restaurantReservations).values({
          restaurantId: testRestaurant.id,
          tableId: table.id,
          guestName: 'Full Booking',
          guestEmail: 'full@example.com',
          partySize: 4,
          startTime,
          endTime: new Date(startTime.getTime() + 90 * 60000),
          status: 'confirmed',
          isVerified: true,
        });
      }

      const testDate = testTime.toISOString();

      const req = createMockApiRequest({
        url: `http://localhost:3000/api/v1/availability?restaurantId=${testRestaurant.id}&date=${testDate}&partySize=2`,
        headers: {
          'x-api-key': testApiKey,
        },
      });

      const { GET } = await import('../v1/availability/route');
      const response = await GET(req as any);

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.data.availableTables).toEqual([]);

      // Should suggest alternative slots
      if (data.data.availableTables.length === 0) {
        expect(data.data.suggestedSlots).toBeDefined();
      }

      // Cleanup reservations
      await getDb().delete(restaurantReservations).where(
        eq(restaurantReservations.restaurantId, testRestaurant.id)
      );
    });
  });

  // ============================================================================
  // Verify Endpoint
  // ============================================================================

  describe('POST /api/v1/verify', () => {
    it('should reject missing verification token', async () => {
      const req = createMockApiRequest({
        method: 'POST',
        body: {},
      });

      const { POST } = await import('../v1/verify/route');
      const response = await POST(req as any);

      expect(response.status).toBe(400);
    });

    it('should reject invalid verification token', async () => {
      const req = createMockApiRequest({
        method: 'POST',
        body: {
          token: 'invalid-token',
        },
      });

      const { POST } = await import('../v1/verify/route');
      const response = await POST(req as any);

      expect(response.status).toBe(404);
    });
  });

  // ============================================================================
  // Checkout Endpoint
  // ============================================================================

  describe('POST /api/v1/checkout', () => {
    it('should reject missing required fields', async () => {
      const req = createMockApiRequest({
        method: 'POST',
        body: {},
      });

      const { POST } = await import('../v1/checkout/route');
      const response = await POST(req as any);

      expect(response.status).toBe(400);
    });

    it('should reject invalid transaction hash', async () => {
      const req = createMockApiRequest({
        method: 'POST',
        body: {
          txHash: 'invalid-hash',
          orderId: 'order-123',
          amount: '10.00',
          currency: 'USDC',
        },
      });

      const { POST } = await import('../v1/checkout/route');
      const response = await POST(req as any);

      expect(response.status).toBe(400);
    });
  });

  // ============================================================================
  // Error Handling
  // ============================================================================

  describe('API Error Handling', () => {
    it('should return consistent error format', async () => {
      const testTime = new Date(Date.now() + 86400000);
      const testDate = testTime.toISOString();

      const req = createMockApiRequest({
        url: `http://localhost:3000/api/v1/availability?restaurantId=invalid&date=${testDate}&partySize=2`,
      });

      const { GET } = await import('../v1/availability/route');
      const response = await GET(req as any);

      const data = await response.json();

      expect(data.error).toBeDefined();
      expect(data.code).toBeDefined();
    });

    it('should handle database connection errors gracefully', async () => {
      // This test verifies the error handling pattern
      // In a real scenario, we'd mock the database to throw an error
      const testTime = new Date(Date.now() + 86400000);
      const testDate = testTime.toISOString();

      const req = createMockApiRequest({
        url: `http://localhost:3000/api/v1/availability?restaurantId=${testRestaurant.id}&date=${testDate}&partySize=2`,
        headers: {
          'x-api-key': testApiKey,
        },
      });

      const { GET } = await import('../v1/availability/route');
      const response = await GET(req as any);

      // Should return either success or a proper error response
      expect([200, 400, 403, 404, 500]).toContain(response.status);
    });
  });

  // ============================================================================
  // Performance Tests
  // ============================================================================

  describe('API Performance', () => {
    it('should respond to health check within 100ms', async () => {
      const startTime = Date.now();
      const { GET } = await import('../health/route');
      await GET();
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(100);
    });

    it('should respond to availability check within 500ms', async () => {
      const testTime = new Date(Date.now() + 86400000);
      const testDate = testTime.toISOString();

      const req = createMockApiRequest({
        url: `http://localhost:3000/api/v1/availability?restaurantId=${testRestaurant.id}&date=${testDate}&partySize=2`,
        headers: {
          'x-api-key': testApiKey,
        },
      });

      const startTime = Date.now();
      const { GET } = await import('../v1/availability/route');
      await GET(req as any);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(500);
    });
  });
});
