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

import { describe, it, expect, beforeEach, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { ConflictError } from '@repo/shared/errors';

// ============================================================================
// MOCKS - Must be declared before any other imports
// ============================================================================

const mockRestaurantsFindFirst = vi.fn();
const mockGuestProfilesFindFirst = vi.fn();
const mockDbInsert = vi.fn();
const mockTransaction = vi.fn();
const mockValidateRequest = vi.fn();
const mockIdempotencyIsDuplicate = vi.fn();
const mockRealtimePublish = vi.fn();
const mockNotifyClaim = vi.fn();
const mockNotifyOwner = vi.fn();
const mockNotifyRejection = vi.fn();
const mockSendNotification = vi.fn();
const mockCreateEvent = vi.fn();

// Mock next/server
vi.mock('next/server', async () => {
  const actual = await vi.importActual('next/server');
  return {
    ...(actual as any),
    NextRequest: vi.fn(),
    NextResponse: {
      json: vi.fn((data: any, init?: any) => ({
        status: init?.status || 200,
        headers: init?.headers || {},
        json: async () => data,
      })),
    },
  };
});

// Mock @repo/database
vi.mock('@repo/database', () => ({
  getDb: vi.fn(() => ({
    query: {
      restaurants: { findFirst: mockRestaurantsFindFirst },
      guestProfiles: { findFirst: mockGuestProfilesFindFirst },
      restaurantTables: { findFirst: vi.fn() },
      restaurantReservations: { findFirst: vi.fn() },
    },
    insert: mockDbInsert,
    transaction: mockTransaction,
  })),
  restaurants: { id: 'id', name: 'name', slug: 'slug', ownerEmail: 'owner_email', ownerId: 'owner_id', apiKey: 'api_key', isShadow: 'is_shadow', isClaimed: 'is_claimed' },
  restaurantReservations: { id: 'id', restaurantId: 'restaurant_id', tableId: 'table_id', combinedTableIds: 'combined_table_ids', guestName: 'guest_name', guestEmail: 'guest_email', partySize: 'party_size', startTime: 'start_time', endTime: 'end_time', status: 'status', isVerified: 'is_verified', createdAt: 'created_at' },
  guestProfiles: { id: 'id', restaurantId: 'restaurant_id', email: 'email', name: 'name', visitCount: 'visit_count', preferences: 'preferences', defaultDeliveryAddress: 'default_delivery_address', updatedAt: 'updated_at' },
  restaurantTables: { id: 'id', restaurantId: 'restaurant_id', isActive: 'is_active', minCapacity: 'min_capacity', maxCapacity: 'max_capacity', status: 'status' },
  and: vi.fn((...args) => ({ type: 'and', args })),
  eq: vi.fn((col, val) => ({ type: 'eq', column: col, value: val })),
  gte: vi.fn((col, val) => ({ type: 'gte', column: col, value: val })),
  lte: vi.fn((col, val) => ({ type: 'lte', column: col, value: val })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  sql: vi.fn((strings, ...values) => ({ type: 'raw', strings, values })),
}));

// Mock @tablestack/lib/auth
vi.mock('@tablestack/lib/auth', () => ({
  validateRequest: mockValidateRequest,
}));

// Mock @repo/shared
vi.mock('@repo/shared', async () => {
  const actual = await vi.importActual('@repo/shared');
  
  // Create a proper Logger class
  class MockLogger {
    constructor(_opts: any) {}
    error = vi.fn();
    warn = vi.fn();
    info = vi.fn();
  }
  
  // Create a proper IdempotencyService class
  class MockIdempotencyService {
    constructor(_redis: any) {}
    isDuplicate = mockIdempotencyIsDuplicate;
  }
  
  return {
    ...(actual as any),
    IdempotencyService: MockIdempotencyService,
    IDEMPOTENCY_KEY_HEADER: 'x-idempotency-key',
    RealtimeService: {
      publishNervousSystemEvent: mockRealtimePublish,
    },
    Logger: MockLogger,
    getRedisClient: vi.fn(),
    ServiceNamespace: { TS: 'ts' },
    withApiErrorHandler: vi.fn((handler: any) => handler),
    validateRequest: (schema: any, data: any) => {
      const result = schema.safeParse(data);
      if (!result.success) {
        return { success: false, error: { code: 'VALIDATION_ERROR', message: result.error.message } };
      }
      return { success: true, data: result.data };
    },
    ReserveRequestSchema: (actual as any).ReserveRequestSchema,
    formatApiError: vi.fn((error: Error, code: string) => ({ error: error.message, code })),
    formatApiSuccess: vi.fn((data: any, meta: any) => ({ success: true, ...data, ...meta })),
  };
});

// Mock notifications
vi.mock('@tablestack/lib/notifications', () => ({
  NotifyService: {
    sendNotification: mockSendNotification,
    sendClaimInvitation: mockNotifyClaim,
    notifyOwner: mockNotifyOwner,
    notifyRejection: mockNotifyRejection,
  },
}));

// Mock @repo/mcp-protocol
vi.mock('@repo/mcp-protocol', () => ({
  createTypedSystemEvent: mockCreateEvent,
}));

// Mock @repo/shared/tracing
vi.mock('@repo/shared/tracing', () => ({
  withNervousSystemTracing: vi.fn(),
  injectTracingHeaders: vi.fn(),
}));

// Import mocked route - will use the mocked modules
let POST: (req: NextRequest) => Promise<any>;

beforeAll(async () => {
  const route = await import('../route');
  POST = route.POST;
});

// ============================================================================
// TEST HELPERS
// ============================================================================

function createMockRequest(options: {
  headers?: Record<string, string>;
  method?: string;
  url?: string;
  body?: any;
} = {}) {
  const { headers = {}, method = 'POST', url = 'http://localhost:3000/api/v1/reserve', body = {} } = options;

  return {
    json: vi.fn(async () => body),
    headers: {
      get: vi.fn((name: string) => headers[name.toLowerCase()] || headers[name] || null),
    },
    method,
    url,
  } as unknown as NextRequest;
}

function createMockRestaurant(overrides?: Record<string, any>) {
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

function createMockReservation(overrides?: Record<string, any>) {
  return {
    id: 'res-123',
    restaurantId: 'rest-123',
    tableId: 'table-123',
    guestName: 'Test Guest',
    guestEmail: 'guest@example.com',
    guestPhone: '+1234567890',
    partySize: 2,
    startTime: new Date(),
    endTime: new Date(Date.now() + 90 * 60000),
    status: 'confirmed',
    isVerified: false,
    verificationToken: 'verify-token-123',
    ...overrides,
  };
}

function createMockProfile(overrides?: Record<string, any>) {
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
    mockValidateRequest.mockResolvedValue({
      context: { restaurantId: 'rest-123' },
    });
    mockIdempotencyIsDuplicate.mockResolvedValue(false);
    mockRestaurantsFindFirst.mockResolvedValue(createMockRestaurant());
    mockGuestProfilesFindFirst.mockResolvedValue(null);
    mockDbInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([createMockReservation()]),
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([createMockProfile()]),
        }),
      }),
    });
    mockTransaction.mockImplementation(async (fn) => {
      return fn({
        query: {
          restaurantReservations: { findFirst: vi.fn().mockResolvedValue(null) },
        },
        insert: mockDbInsert,
        execute: vi.fn().mockResolvedValue([{ id: 'table-123' }]),
      });
    });
    mockCreateEvent.mockReturnValue({
      type: 'HighValueGuestReservation',
      payload: {},
      source: 'table-stack',
      traceId: undefined,
    });
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
      const response = await POST(req);

      expect(response.status).toBe(401);
      expect(mockValidateRequest).toHaveBeenCalledWith(req);
    });

    it('should accept valid authentication', async () => {
      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: 'rest-123' },
      });

      const req = createMockRequest({ body: {} });
      await POST(req);

      expect(mockValidateRequest).toHaveBeenCalledWith(req);
    });
  });

  // ============================================================================
  // Idempotency
  // ============================================================================

  describe('POST - Idempotency', () => {
    it('should process request with unique idempotency key', async () => {
      const req = createMockRequest({
        headers: { 'x-idempotency-key': 'unique-key-123' },
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          guestPhone: '+1234567890',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      await POST(req);

      expect(mockIdempotencyIsDuplicate).toHaveBeenCalled();
    });

    it('should return duplicate response for existing idempotency key', async () => {
      mockIdempotencyIsDuplicate.mockResolvedValue(true);

      const req = createMockRequest({
        headers: { 'x-idempotency-key': 'duplicate-key-123' },
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          guestPhone: '+1234567890',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const response = await POST(req);

      expect(response.status).toBe(200);
      expect(response.headers).toEqual({ 'x-idempotency-duplicate': 'true' });
    });
  });

  // ============================================================================
  // Input Validation
  // ============================================================================

  describe('POST - Input Validation', () => {
    it('should reject request with missing restaurant identifier', async () => {
      const req = createMockRequest({
        body: {
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          guestPhone: '+1234567890',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

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

      const response = await POST(req);

      expect(response.status).toBe(400);
    });

    it('should reject request with missing party size', async () => {
      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          guestPhone: '+1234567890',
          startTime: new Date().toISOString(),
        },
      });

      const response = await POST(req);

      expect(response.status).toBe(400);
    });

    it('should reject request with missing start time', async () => {
      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          guestPhone: '+1234567890',
          partySize: 2,
        },
      });

      const response = await POST(req);

      expect(response.status).toBe(400);
    });

    it.skip('should reject unauthorized restaurant access', async () => {
      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: 'rest-123' },
      });

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-456',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          guestPhone: '+1234567890',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const response = await POST(req);

      expect(response.status).toBe(403);
    });
  });

  // ============================================================================
  // Shadow Restaurant
  // ============================================================================

  describe('POST - Shadow Restaurant', () => {
    it.skip('should create shadow restaurant for internal discovery', async () => {
      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: undefined, isInternal: true },
      });
      mockRestaurantsFindFirst.mockResolvedValue(null);

      const mockInsertChain = {
        returning: vi.fn().mockResolvedValue([createMockRestaurant({ isShadow: true, isClaimed: false, id: 'new-shadow' })]),
      };
      mockDbInsert.mockReturnValue({
        values: vi.fn().mockReturnValue(mockInsertChain),
      });

      const req = createMockRequest({
        body: {
          restaurantName: 'New Shadow Restaurant',
          restaurantEmail: 'shadow@example.com',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          guestPhone: '+1234567890',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      await POST(req);

      expect(mockDbInsert).toHaveBeenCalled();
      expect(mockNotifyClaim).toHaveBeenCalled();
    });

    it.skip('should find existing shadow restaurant', async () => {
      mockValidateRequest.mockResolvedValue({
        context: { restaurantId: undefined, isInternal: true },
      });
      mockRestaurantsFindFirst.mockResolvedValue(createMockRestaurant({ isShadow: true }));

      const req = createMockRequest({
        body: {
          restaurantName: 'Existing Shadow Restaurant',
          restaurantEmail: 'shadow@example.com',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          guestPhone: '+1234567890',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      await POST(req);

      expect(mockRestaurantsFindFirst).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Guest Profile
  // ============================================================================

  describe('POST - Guest Profile', () => {
    it.skip('should create new guest profile', async () => {
      mockGuestProfilesFindFirst.mockResolvedValue(null);

      const mockProfileInsert = {
        returning: vi.fn().mockResolvedValue([createMockProfile({ visitCount: 1 })]),
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([createMockProfile({ visitCount: 1 })]),
        }),
      };

      mockDbInsert.mockImplementation(() => ({
        values: vi.fn().mockReturnValue(mockProfileInsert),
      }));

      mockTransaction.mockImplementation(async (fn) => fn({
        query: { restaurantReservations: { findFirst: vi.fn().mockResolvedValue(null) } },
        insert: mockDbInsert,
        execute: vi.fn().mockResolvedValue([{ id: 'table-123' }]),
      }));

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'New Guest',
          guestEmail: 'new@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      await POST(req);

      expect(mockDbInsert).toHaveBeenCalled();
    });

    it.skip('should update existing guest profile visit count', async () => {
      mockGuestProfilesFindFirst.mockResolvedValue(createMockProfile({ visitCount: 5 }));

      const mockProfileInsert = {
        returning: vi.fn().mockResolvedValue([createMockProfile({ visitCount: 6 })]),
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([createMockProfile({ visitCount: 6 })]),
        }),
      };

      mockDbInsert.mockImplementation(() => ({
        values: vi.fn().mockReturnValue(mockProfileInsert),
      }));

      mockTransaction.mockImplementation(async (fn) => fn({
        query: { restaurantReservations: { findFirst: vi.fn().mockResolvedValue(null) } },
        insert: mockDbInsert,
        execute: vi.fn().mockResolvedValue([{ id: 'table-123' }]),
      }));

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'Returning Guest',
          guestEmail: 'returning@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      await POST(req);

      expect(mockDbInsert).toHaveBeenCalled();
      expect(mockProfileInsert.onConflictDoUpdate).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // High-Value Guest
  // ============================================================================

  describe('POST - High-Value Guest', () => {
    it.skip('should trigger Nervous System event for high-value guest (visitCount >= 5)', async () => {
      mockGuestProfilesFindFirst.mockResolvedValue(createMockProfile({ visitCount: 7 }));

      const mockProfileInsert = {
        returning: vi.fn().mockResolvedValue([createMockProfile({ visitCount: 7 })]),
        onConflictDoUpdate: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([createMockProfile({ visitCount: 7 })]),
        }),
      };

      mockDbInsert.mockImplementation(() => ({
        values: vi.fn().mockReturnValue(mockProfileInsert),
      }));

      mockTransaction.mockImplementation(async (fn) => fn({
        query: { restaurantReservations: { findFirst: vi.fn().mockResolvedValue(null) } },
        insert: mockDbInsert,
        execute: vi.fn().mockResolvedValue([{ id: 'table-123' }]),
      }));

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'VIP Guest',
          guestEmail: 'vip@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      await POST(req);

      expect(mockRealtimePublish).toHaveBeenCalledWith(
        'HighValueGuestReservation',
        expect.any(Object),
        undefined
      );
    });

    it('should not trigger Nervous System event for regular guests', async () => {
      mockGuestProfilesFindFirst.mockResolvedValue(createMockProfile({ visitCount: 2 }));

      mockDbInsert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([createMockReservation()]),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([createMockProfile({ visitCount: 2 })]),
          }),
        }),
      });

      mockTransaction.mockImplementation(async (fn) => fn({
        query: { restaurantReservations: { findFirst: vi.fn().mockResolvedValue(null) } },
        insert: mockDbInsert,
        execute: vi.fn().mockResolvedValue([{ id: 'table-123' }]),
      }));

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'Regular Guest',
          guestEmail: 'regular@example.com',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      await POST(req);

      expect(mockRealtimePublish).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Conflict Detection
  // ============================================================================

  describe('POST - Conflict Detection', () => {
    it.skip('should handle table conflict error', async () => {
      mockTransaction.mockImplementation(async () => {
        throw new ConflictError('No suitable tables available');
      });

      const req = createMockRequest({
        headers: { 'x-idempotency-key': 'conflict-test-key' },
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          guestPhone: '+1234567890',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const response = await POST(req);

      expect(response.status).toBe(409);
      expect(mockNotifyRejection).toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Error Handling
  // ============================================================================

  describe('POST - Error Handling', () => {
    it.skip('should handle restaurant not found', async () => {
      mockRestaurantsFindFirst.mockResolvedValue(null);

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          guestPhone: '+1234567890',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const response = await POST(req);

      expect(response.status).toBe(404);
    });

    it.skip('should handle database errors', async () => {
      mockRestaurantsFindFirst.mockRejectedValue(new Error('Database connection failed'));

      const req = createMockRequest({
        body: {
          restaurantId: 'rest-123',
          guestName: 'Test Guest',
          guestEmail: 'guest@example.com',
          guestPhone: '+1234567890',
          partySize: 2,
          startTime: new Date().toISOString(),
        },
      });

      const response = await POST(req);

      expect(response.status).toBe(500);
    });
  });
});
