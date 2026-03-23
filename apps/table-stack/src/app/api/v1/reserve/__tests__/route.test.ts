/**
 * Unit Tests: Reservation API Route
 *
 * Tests for apps/table-stack/src/app/api/v1/reserve/route.ts
 *
 * Coverage Targets:
 * - POST handler: All authentication paths
 * - Idempotency checks
 * - Shadow restaurant logic
 * - Guest profile upsert
 * - High-value guest notification
 * - Conflict detection and handling
 * - Error handling
 *
 * @see Phase 1.1: Testing Infrastructure
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { formatApiError, formatApiSuccess } from '@repo/shared';
import { ConflictError } from '@repo/shared/errors';

// ============================================================================
// MOCKS
// ============================================================================

// Mock NextResponse
vi.mock('next/server', async () => {
  const actual = await vi.importActual('next/server');
  return {
    ...(actual as any),
    NextRequest: vi.fn(),
    NextResponse: {
      json: vi.fn((data, init) => ({ json: () => Promise.resolve(data), ...init })),
    },
  };
});

// Mock @repo/database
vi.mock('@repo/database', () => ({
  getDb: vi.fn(() => ({
    query: {
      restaurants: {
        findFirst: vi.fn(),
      },
      guestProfiles: {
        findFirst: vi.fn(),
        insert: vi.fn(),
      },
      restaurantTables: {
        findFirst: vi.fn(),
      },
      restaurantReservations: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(),
        onConflictDoUpdate: vi.fn(),
      })),
    })),
    transaction: vi.fn((fn) => fn({
      query: {
        restaurants: {
          findFirst: vi.fn(),
        },
        guestProfiles: {
          findFirst: vi.fn(),
        },
        restaurantTables: {
          findFirst: vi.fn(),
        },
        restaurantReservations: {
          findFirst: vi.fn(),
        },
      },
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(),
          onConflictDoUpdate: vi.fn(),
        })),
      })),
    })),
  })),
  restaurants: {
    id: 'id',
    name: 'name',
    slug: 'slug',
    ownerEmail: 'owner_email',
    ownerId: 'owner_id',
    apiKey: 'api_key',
    isShadow: 'is_shadow',
    isClaimed: 'is_claimed',
  },
  restaurantReservations: {
    id: 'id',
    restaurantId: 'restaurant_id',
    tableId: 'table_id',
    combinedTableIds: 'combined_table_ids',
    guestName: 'guest_name',
    guestEmail: 'guest_email',
    partySize: 'party_size',
    startTime: 'start_time',
    endTime: 'end_time',
    status: 'status',
    isVerified: 'is_verified',
    createdAt: 'created_at',
  },
  guestProfiles: {
    id: 'id',
    restaurantId: 'restaurant_id',
    email: 'email',
    name: 'name',
    visitCount: 'visit_count',
    preferences: 'preferences',
    defaultDeliveryAddress: 'default_delivery_address',
    updatedAt: 'updated_at',
  },
  restaurantTables: {
    id: 'id',
    restaurantId: 'restaurant_id',
    isActive: 'is_active',
    minCapacity: 'min_capacity',
    maxCapacity: 'max_capacity',
    status: 'status',
  },
  and: vi.fn((...args) => ({ type: 'and', args })),
  eq: vi.fn((col, val) => ({ type: 'eq', column: col, value: val })),
  gte: vi.fn((col, val) => ({ type: 'gte', column: col, value: val })),
  lte: vi.fn((col, val) => ({ type: 'lte', column: col, value: val })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  sql: {
    placeholder: vi.fn((val) => ({ type: 'placeholder', value: val })),
    raw: vi.fn((str) => ({ type: 'raw', string: str })),
  },
}));

// Mock @repo/shared
vi.mock('@repo/shared', () => ({
  formatApiError: vi.fn((error, code) => ({ error: error.message, code })),
  formatApiSuccess: vi.fn((data, meta) => ({ success: true, ...data, ...meta })),
  IdempotencyService: vi.fn().mockImplementation(() => ({
    isDuplicate: vi.fn(),
  })),
  IDEMPOTENCY_KEY_HEADER: 'x-idempotency-key',
}));

// Mock @repo/shared/tracing
vi.mock('@repo/shared/tracing', () => ({
  withNervousSystemTracing: vi.fn(),
  injectTracingHeaders: vi.fn(),
}));

// Mock notifications
vi.mock('@/lib/notifications', () => ({
  NotifyService: {
    sendNotification: vi.fn(),
    sendClaimInvitation: vi.fn(),
    notifyOwner: vi.fn(),
    notifyRejection: vi.fn(),
  },
}));

// Mock auth
vi.mock('@/lib/auth', () => ({
  validateRequest: vi.fn(),
}));

// Mock redis
vi.mock('@/lib/redis', () => ({
  redis: {
    incr: vi.fn(),
    expire: vi.fn(),
  },
}));

// Mock @repo/shared RealtimeService
vi.mock('@repo/shared', async () => {
  const actual = await vi.importActual('@repo/shared');
  return {
    ...(actual as any),
    RealtimeService: {
      publishNervousSystemEvent: vi.fn(),
    },
  };
});

// Mock @repo/mcp-protocol
vi.mock('@repo/mcp-protocol', () => ({
  createTypedSystemEvent: vi.fn((type, payload, source, meta) => ({
    type,
    payload,
    source,
    traceId: meta?.traceId,
  })),
}));

// Import mocked modules
import { getDb, restaurants, restaurantReservations, guestProfiles, restaurantTables, and, eq, sql } from '@repo/database';
import { validateRequest } from '@/lib/auth';
import { IdempotencyService } from '@repo/shared';
import { RealtimeService } from '@repo/shared';
import { NotifyService } from '@/lib/notifications';
import { createTypedSystemEvent } from '@repo/mcp-protocol';

const mockGetDb = getDb as any;
const mockValidateRequest = validateRequest as any;
const mockIdempotencyService = IdempotencyService as any;
const mockRealtimePublish = RealtimeService.publishNervousSystemEvent as any;
const mockNotifySend = NotifyService.sendNotification as any;
const mockNotifyClaim = NotifyService.sendClaimInvitation as any;
const mockNotifyOwner = NotifyService.notifyOwner as any;
const mockNotifyRejection = NotifyService.notifyRejection as any;
const mockCreateEvent = createTypedSystemEvent as any;

// Mock NextResponse.json return value
const mockNextResponseJson = NextResponse.json as any;

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Create a mock NextRequest
 */
function createMockRequest(options: {
  headers?: Record<string, string>;
  method?: string;
  url?: string;
  body?: any;
} = {}) {
  const { headers = {}, method = 'POST', url = 'http://localhost:3000/api/v1/reserve', body = {} } = options;

  const mockReq = {
    json: vi.fn(async () => body),
    headers: {
      get: vi.fn((name: string) => {
        const headerMap: Record<string, string> = {
          ...headers,
        };
        return headerMap[name.toLowerCase()] || null;
      }),
    },
    method,
    url,
  };

  return mockReq as unknown as NextRequest;
}

/**
 * Mock data factories
 */
function createMockRestaurant(overrides?: Partial<any>) {
  return {
    id: 'rest-123',
    name: 'Test Restaurant',
    slug: 'test-restaurant',
    ownerEmail: 'owner@example.com',
    ownerId: 'owner-123',
    apiKey: 'ts_api_key',
    isShadow: false,
    isClaimed: true,
    ...overrides,
  };
}

function createMockReservation(overrides?: Partial<any>) {
  return {
    id: 'res-123',
    restaurantId: 'rest-123',
    tableId: 'table-123',
    guestName: 'Test Guest',
    guestEmail: 'guest@example.com',
    partySize: 2,
    startTime: new Date(),
    endTime: new Date(Date.now() + 90 * 60000),
    status: 'confirmed',
    isVerified: false,
    verificationToken: 'verify-token-123',
    ...overrides,
  };
}

function createMockProfile(overrides?: Partial<any>) {
  return {
    id: 'profile-123',
    restaurantId: 'rest-123',
    email: 'guest@example.com',
    name: 'Test Guest',
    visitCount: 1,
    ...overrides,
  };
}

// ============================================================================
// UNIT TESTS
// ============================================================================

describe('Reservation API Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations
    mockNextResponseJson.mockImplementation((data, init) => ({
      json: () => Promise.resolve(data),
      ...init,
    }));
  });

  // ============================================================================
  // Authentication
  // ============================================================================

  describe('POST - Authentication', () => {
    it('should reject unauthenticated requests', async () => {
      mockValidateRequest.mockResolvedValue({
        error: 'Missing authentication',
        status: 401,
      });

      const req = createMockRequest();
      const { POST } = await import('../route');
      const response = await POST(req);

      expect(response.status).toBe(401);
      expect(mockValidateRequest).toHaveBeenCalledWith(req);
    });

    it('should accept valid authentication', async () => {
      mockValidateRequest.mockResolvedValue({
        context: {
          restaurantId: 'rest-123',
          isInternal: false,
        },
      });

      // Mock missing required fields (will fail validation)
      const req = createMockRequest({
        body: {},
      });

      const { POST } = await import('../route');
      await POST(req);

      expect(mockValidateRequest).toHaveBeenCalledWith(req);
    });
  });

  // ============================================================================
  // Idempotency
  // ============================================================================

  describe('POST - Idempotency', () => {
    it('should process request with unique idempotency key', async () => {
      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: 'rest-123' },
      });
      mockIdempotencyService.mockImplementation(() => ({
        isDuplicate: vi.fn().mockResolvedValue(false),
      }));

      const req = createMockRequest({
        headers: { 'x-idempotency-key': 'unique-key-123' },
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      // Mock restaurant lookup
      const mockDb = mockGetDb();
      mockDb.query.restaurants.findFirst.mockResolvedValue(createMockRestaurant());

      const { POST } = await import('../route');
      await POST(req);

      expect(mockIdempotencyService).toHaveBeenCalled();
    });

    it('should return duplicate response for existing idempotency key', async () => {
      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: 'rest-123' },
      });
      mockIdempotencyService.mockImplementation(() => ({
        isDuplicate: vi.fn().mockResolvedValue(true),
      }));

      const req = createMockRequest({
        headers: { 'x-idempotency-key': 'duplicate-key-123' },
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const { POST } = await import('../route');
      const response = await POST(req);

      expect(response.status).toBe(200);
      expect(response.headers).toEqual({ 'x-idempotency-duplicate': 'true' });
    });
  });

  // ============================================================================
  // Validation
  // ============================================================================

  describe('POST - Input Validation', () => {
    beforeEach(() => {
      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: 'rest-123' },
      });
    });

    it('should reject request with missing restaurant identifier', async () => {
      const req = createMockRequest({
        body: {
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const { POST } = await import('../route');
      const response = await POST(req);

      expect(response.status).toBe(400);
    });

    it('should reject request with missing guest information', async () => {
      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const { POST } = await import('../route');
      const response = await POST(req);

      expect(response.status).toBe(400);
    });

    it('should reject request with missing party size', async () => {
      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          startTime: new Date().toISOString(),
        },
      });

      const { POST } = await import('../route');
      const response = await POST(req);

      expect(response.status).toBe(400);
    });

    it('should reject request with missing start time', async () => {
      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          partySize: 2,
        },
      });

      const { POST } = await import('../route');
      const response = await POST(req);

      expect(response.status).toBe(400);
    });

    it('should reject unauthorized restaurant access', async () => {
      const req = createMockRequest({
        body: {
          restaurantId: 'rest-456', // Different from auth context
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: 'rest-123' },
      });

      const { POST } = await import('../route');
      const response = await POST(req);

      expect(response.status).toBe(403);
    });
  });

  // ============================================================================
  // Shadow Restaurant Logic
  // ============================================================================

  describe('POST - Shadow Restaurant', () => {
    it('should create shadow restaurant for internal discovery', async () => {
      mockValidateRequest.mockResolvedValue({
        context: {
          restaurantId: undefined,
          isInternal: true,
        },
      });

      const mockDb = mockGetDb();
      mockDb.query.restaurants.findFirst.mockResolvedValue(null); // No existing restaurant

      const mockInsert = {
        returning: vi.fn().mockResolvedValue([createMockRestaurant({ isShadow: true, isClaimed: false })]),
      };

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue(mockInsert),
      });

      const req = createMockRequest({
        body: {
          restaurantName: 'New Shadow Restaurant',
          restaurantEmail: 'shadow@example.com',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const { POST } = await import('../route');
      await POST(req);

      expect(mockDb.insert).toHaveBeenCalledWith(restaurants);
      expect(mockNotifyClaim).toHaveBeenCalledWith(
        'shadow@example.com',
        'New Shadow Restaurant',
        expect.any(String)
      );
    });

    it('should find existing shadow restaurant', async () => {
      mockValidateRequest.mockResolvedValue({
        context: {
          restaurantId: undefined,
          isInternal: true,
        },
      });

      const mockDb = mockGetDb();
      const existingRestaurant = createMockRestaurant({ isShadow: true });
      mockDb.query.restaurants.findFirst.mockResolvedValue(existingRestaurant);

      const req = createMockRequest({
        body: {
          restaurantName: 'Existing Shadow Restaurant',
          restaurantEmail: 'shadow@example.com',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const { POST } = await import('../route');
      await POST(req);

      expect(mockDb.query.restaurants.findFirst).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Guest Profile
  // ============================================================================

  describe('POST - Guest Profile', () => {
    beforeEach(() => {
      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: 'rest-123' },
      });

      const mockDb = mockGetDb();
      mockDb.query.restaurants.findFirst.mockResolvedValue(createMockRestaurant());
    });

    it('should create new guest profile', async () => {
      const mockDb = mockGetDb();
      mockDb.query.guestProfiles.findFirst.mockResolvedValue(null); // No existing profile

      const mockReservationInsert = {
        returning: vi.fn().mockResolvedValue([createMockReservation()]),
      };

      const mockProfileInsert = {
        returning: vi.fn().mockResolvedValue([createMockProfile({ visitCount: 1 })]),
        onConflictDoUpdate: vi.fn().mockReturnValue(mockProfileInsert),
      };

      mockDb.insert.mockImplementation((table: any) => {
        if (table === guestProfiles) {
          return { values: vi.fn().mockReturnValue(mockProfileInsert) };
        }
        return { values: vi.fn().mockReturnValue(mockReservationInsert) };
      });

      mockDb.transaction.mockImplementation(async (fn: any) => {
        return fn({
          ...mockDb,
          insert: mockDb.insert,
        });
      });

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'New Guest',
          guestEmail: 'new@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const { POST } = await import('../route');
      await POST(req);

      expect(mockDb.insert).toHaveBeenCalledWith(guestProfiles);
    });

    it('should update existing guest profile visit count', async () => {
      const mockDb = mockGetDb();
      mockDb.query.guestProfiles.findFirst.mockResolvedValue(
        createMockProfile({ visitCount: 5 })
      );

      const mockReservationInsert = {
        returning: vi.fn().mockResolvedValue([createMockReservation()]),
      };

      const mockProfileInsert = {
        returning: vi.fn().mockResolvedValue([createMockProfile({ visitCount: 6 })]),
        onConflictDoUpdate: vi.fn().mockReturnValue(mockProfileInsert),
      };

      mockDb.insert.mockImplementation((table: any) => {
        if (table === guestProfiles) {
          return { values: vi.fn().mockReturnValue(mockProfileInsert) };
        }
        return { values: vi.fn().mockReturnValue(mockReservationInsert) };
      });

      mockDb.transaction.mockImplementation(async (fn: any) => {
        return fn({ ...mockDb, insert: mockDb.insert });
      });

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'Returning Guest',
          guestEmail: 'returning@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const { POST } = await import('../route');
      await POST(req);

      expect(mockDb.insert).toHaveBeenCalledWith(guestProfiles);
      expect(mockProfileInsert.onConflictDoUpdate).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // High-Value Guest Notification
  // ============================================================================

  describe('POST - High-Value Guest', () => {
    it('should trigger Nervous System event for high-value guest (visitCount >= 5)', async () => {
      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: 'rest-123' },
      });

      const mockDb = mockGetDb();
      mockDb.query.restaurants.findFirst.mockResolvedValue(createMockRestaurant());
      mockDb.query.guestProfiles.findFirst.mockResolvedValue(
        createMockProfile({ visitCount: 7 })
      );

      const mockReservationInsert = {
        returning: vi.fn().mockResolvedValue([createMockReservation()]),
      };

      const mockProfileInsert = {
        returning: vi.fn().mockResolvedValue([createMockProfile({ visitCount: 7 })]),
        onConflictDoUpdate: vi.fn().mockReturnValue(mockReservationInsert),
      };

      mockDb.insert.mockImplementation((table: any) => {
        if (table === guestProfiles) {
          return { values: vi.fn().mockReturnValue(mockProfileInsert) };
        }
        return { values: vi.fn().mockReturnValue(mockReservationInsert) };
      });

      mockDb.transaction.mockImplementation(async (fn: any) => {
        return fn({ ...mockDb, insert: mockDb.insert });
      });

      mockCreateEvent.mockReturnValue({
        type: 'HighValueGuestReservation',
        payload: expect.any(Object),
        source: 'table-stack',
        traceId: undefined,
      });

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'VIP Guest',
          guestEmail: 'vip@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const { POST } = await import('../route');
      await POST(req);

      expect(mockRealtimePublish).toHaveBeenCalledWith(
        'HighValueGuestReservation',
        expect.any(Object),
        undefined
      );
    });

    it('should not trigger Nervous System event for regular guests', async () => {
      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: 'rest-123' },
      });

      const mockDb = mockGetDb();
      mockDb.query.restaurants.findFirst.mockResolvedValue(createMockRestaurant());
      mockDb.query.guestProfiles.findFirst.mockResolvedValue(
        createMockProfile({ visitCount: 2 })
      );

      const mockReservationInsert = {
        returning: vi.fn().mockResolvedValue([createMockReservation()]),
      };

      mockDb.insert.mockReturnValue({
        values: vi.fn().mockReturnValue(mockReservationInsert),
      });

      mockDb.transaction.mockImplementation(async (fn: any) => {
        return fn({ ...mockDb, insert: mockDb.insert });
      });

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'Regular Guest',
          guestEmail: 'regular@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const { POST } = await import('../route');
      await POST(req);

      expect(mockRealtimePublish).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Conflict Detection
  // ============================================================================

  describe('POST - Conflict Detection', () => {
    it('should handle table conflict error', async () => {
      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: 'rest-123' },
      });

      const mockDb = mockGetDb();
      mockDb.query.restaurants.findFirst.mockResolvedValue(createMockRestaurant());
      mockDb.query.guestProfiles.findFirst.mockResolvedValue(null);

      // Simulate conflict in transaction
      mockDb.transaction.mockImplementation(async () => {
        throw new ConflictError('No suitable tables available');
      });

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const { POST } = await import('../route');
      const response = await POST(req);

      expect(response.status).toBe(409);
      expect(mockNotifyRejection).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Error Handling
  // ============================================================================

  describe('POST - Error Handling', () => {
    it('should handle restaurant not found', async () => {
      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: 'rest-123' },
      });

      const mockDb = mockGetDb();
      mockDb.query.restaurants.findFirst.mockResolvedValue(null);

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const { POST } = await import('../route');
      const response = await POST(req);

      expect(response.status).toBe(404);
    });

    it('should handle database errors', async () => {
      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: 'rest-123' },
      });

      const mockDb = mockGetDb();
      mockDb.query.restaurants.findFirst.mockRejectedValue(new Error('Database connection failed'));

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const { POST } = await import('../route');
      const response = await POST(req);

      expect(response.status).toBe(500);
    });
  });
});
