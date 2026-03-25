/**
 * Unit Tests: Authentication Module
 *
 * Tests for apps/table-stack/src/lib/auth.ts
 *
 * Coverage Targets:
 * - validateRequest: All authentication paths (JWT, API key, missing auth)
 * - rateLimit: Rate limiting logic
 * - signWebhookPayload / verifyWebhookPayload: HMAC signing
 * - signPayload / verifySignature: Timestamp-based signing
 *
 * @see Phase 1.1: Testing Infrastructure
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  validateRequest,
  generateApiKey,
  signWebhookPayload,
  verifyWebhookPayload,
  signPayload,
  verifySignature,
  type AuthContext,
} from '../auth';

// ============================================================================
// MOCKS
// ============================================================================

// Mock @repo/database - Create a SINGLE mock instance to avoid stale references
vi.mock('@repo/database', async () => {
  const actual = await vi.importActual('@repo/database');
  
  // Create mock query objects
  const mockRestaurantsQuery = {
    findFirst: vi.fn(),
  };

  return {
    ...(actual as any),
    getDb: vi.fn(() => ({
      query: {
        restaurants: mockRestaurantsQuery,
      },
      execute: vi.fn(),
    })),
    restaurants: {
      id: 'id',
      apiKey: 'api_key',
    },
    eq: vi.fn((col, val) => ({ column: col, value: val })),
  };
});

// Mock @repo/auth
vi.mock('@repo/auth', async () => {
  const actual = await vi.importActual('@repo/auth');
  
  const mockVerifyServiceToken = vi.fn();
  const mockVerifyScopedJWT = vi.fn();
  const mockVerifyAsymmetricJWT = vi.fn();
  const mockSecurityProviderVerify = vi.fn();
  const mockSecurityProviderSign = vi.fn();

  return {
    ...(actual as any),
    verifyServiceToken: mockVerifyServiceToken,
    verifyScopedJWT: mockVerifyScopedJWT,
    verifyAsymmetricJWT: mockVerifyAsymmetricJWT,
    SecurityProvider: {
      verifySignature: mockSecurityProviderVerify,
      signPayload: mockSecurityProviderSign,
    },
  };
});

// Mock redis
vi.mock('../redis', () => ({
  redis: {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  },
}));

// Import mocked modules AFTER mocks are hoisted
import { getDb, restaurants, eq } from '@repo/database';
import { verifyServiceToken, verifyScopedJWT, verifyAsymmetricJWT, SecurityProvider } from '@repo/auth';
import { redis } from '@tablestack/lib/redis';

// Get references to mocked functions after import
const mockGetDb = getDb as any;
const mockVerifyServiceToken = verifyServiceToken as any;
const mockVerifyScopedJWT = verifyScopedJWT as any;
const mockVerifyAsymmetricJWT = verifyAsymmetricJWT as any;
const mockRedisIncr = redis.incr as any;
const mockSecurityProviderVerify = SecurityProvider.verifySignature as any;
const mockSecurityProviderSign = SecurityProvider.signPayload as any;

// Helper to get the current mock for restaurants.findFirst
const getMockRestaurantsFindFirst = () => mockGetDb().query.restaurants.findFirst;

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Create a mock NextRequest with custom headers and method
 */
function createMockRequest(options: {
  headers?: Record<string, string>;
  method?: string;
  url?: string;
  body?: any;
} = {}) {
  const { headers = {}, method = 'GET', url = 'http://localhost:3000/api/test', body = null } = options;

  return new NextRequest(new URL(url), {
    method,
    headers: new Headers(headers),
    body: body ? JSON.stringify(body) : undefined,
  });
}

// ============================================================================
// UNIT TESTS
// ============================================================================

describe('Authentication Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ============================================================================
  // validateRequest: Asymmetric JWT (RS256)
  // ============================================================================

  describe('validateRequest - Asymmetric JWT (RS256)', () => {
    it('should authenticate valid asymmetric JWT token', async () => {
      const mockPayload = {
        iss: 'intention-engine',
        sub: 'service-account',
        restaurantId: 'rest-123',
        traceId: 'trace-456',
      };

      mockVerifyAsymmetricJWT.mockResolvedValue(mockPayload);

      const req = createMockRequest({
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
      });

      const result = await validateRequest(req);

      expect(result.error).toBeUndefined();
      expect(result.status).toBeUndefined();
      expect(result.context).toEqual({
        isInternal: true,
        restaurantId: 'rest-123',
        traceId: 'trace-456',
      });

      expect(mockVerifyAsymmetricJWT).toHaveBeenCalledWith(
        'valid-jwt-token',
        'intention-engine',
        'table-stack'
      );
    });

    it('should reject invalid asymmetric JWT and fall back to other methods', async () => {
      mockVerifyAsymmetricJWT.mockResolvedValue(null);
      mockVerifyScopedJWT.mockResolvedValue(null);
      mockVerifyServiceToken.mockResolvedValue(null);

      const req = createMockRequest({
        headers: {
          authorization: 'Bearer invalid-jwt-token',
        },
      });

      const result = await validateRequest(req);

      expect(result.error).toBe('Invalid or expired JWT token');
      expect(result.status).toBe(401);
      expect(result.context).toBeUndefined();
    });
  });

  // ============================================================================
  // validateRequest: Scoped JWT
  // ============================================================================

  describe('validateRequest - Scoped JWT', () => {
    it('should authenticate valid scoped JWT with permissions', async () => {
      const mockPayload = {
        iss: 'internal-service',
        restaurantId: 'rest-789',
        permissions: ['read:reservations', 'write:reservations'],
        traceId: 'trace-abc',
      };

      mockVerifyAsymmetricJWT.mockResolvedValue(null); // Fail first check
      mockVerifyScopedJWT.mockResolvedValue(mockPayload);

      const req = createMockRequest({
        headers: {
          authorization: 'Bearer scoped-jwt-token',
        },
      });

      const result = await validateRequest(req);

      expect(result.error).toBeUndefined();
      expect(result.status).toBeUndefined();
      expect(result.context).toEqual({
        isInternal: true,
        restaurantId: 'rest-789',
        scopedPermissions: ['read:reservations', 'write:reservations'],
        traceId: 'trace-abc',
      });
    });
  });

  // ============================================================================
  // validateRequest: Service Token (HS256 fallback)
  // ============================================================================

  describe('validateRequest - Service Token (HS256 fallback)', () => {
    it('should authenticate valid service token', async () => {
      const mockPayload = {
        service: 'delivery-service',
        restaurantId: 'rest-456',
        traceId: 'trace-def',
      };

      mockVerifyAsymmetricJWT.mockResolvedValue(null);
      mockVerifyScopedJWT.mockResolvedValue(null);
      mockVerifyServiceToken.mockResolvedValue(mockPayload);

      const req = createMockRequest({
        headers: {
          authorization: 'Bearer service-token',
        },
      });

      const result = await validateRequest(req);

      expect(result.error).toBeUndefined();
      expect(result.status).toBeUndefined();
      expect(result.context).toEqual({
        isInternal: true,
        restaurantId: 'rest-456',
        traceId: 'trace-def',
      });
    });
  });

  // ============================================================================
  // validateRequest: API Key (Legacy)
  // ============================================================================

  describe('validateRequest - API Key (Legacy)', () => {
    it('should authenticate valid API key', async () => {
      const mockRestaurant = {
        id: 'rest-api-key-123',
        name: 'Test Restaurant',
        apiKey: 'ts_valid_api_key',
      };

      mockVerifyAsymmetricJWT.mockResolvedValue(null);
      mockVerifyScopedJWT.mockResolvedValue(null);
      mockVerifyServiceToken.mockResolvedValue(null);
      getMockRestaurantsFindFirst().mockResolvedValue(mockRestaurant);
      mockRedisIncr.mockResolvedValue(1); // Rate limit pass

      const req = createMockRequest({
        headers: {
          'x-api-key': 'ts_valid_api_key',
        },
      });

      const result = await validateRequest(req);

      expect(result.error).toBeUndefined();
      expect(result.status).toBeUndefined();
      expect(result.context).toEqual({
        restaurantId: 'rest-api-key-123',
      });

      expect(getMockRestaurantsFindFirst()).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.any(Object),
        })
      );
    });

    it('should reject invalid API key', async () => {
      mockVerifyAsymmetricJWT.mockResolvedValue(null);
      mockVerifyScopedJWT.mockResolvedValue(null);
      mockVerifyServiceToken.mockResolvedValue(null);
      getMockRestaurantsFindFirst().mockResolvedValue(null); // No restaurant found
      mockRedisIncr.mockResolvedValue(1);

      const req = createMockRequest({
        headers: {
          'x-api-key': 'ts_invalid_api_key',
        },
      });

      const result = await validateRequest(req);

      expect(result.error).toBe('Invalid API key');
      expect(result.status).toBe(403);
      expect(result.context).toBeUndefined();
    });

    it('should apply rate limiting to API key requests', async () => {
      mockVerifyAsymmetricJWT.mockResolvedValue(null);
      mockVerifyScopedJWT.mockResolvedValue(null);
      mockVerifyServiceToken.mockResolvedValue(null);

      // Simulate rate limit exceeded (101st request)
      mockRedisIncr.mockResolvedValue(101);

      const req = createMockRequest({
        headers: {
          'x-api-key': 'ts_valid_api_key',
          'x-forwarded-for': '192.168.1.100',
        },
      });

      const result = await validateRequest(req);

      expect(result.error).toBe('Too many requests');
      expect(result.status).toBe(429);
      expect(result.context).toBeUndefined();

      expect(mockRedisIncr).toHaveBeenCalledWith('ratelimit:192.168.1.100');
    });

    it('should handle Redis errors gracefully', async () => {
      mockVerifyAsymmetricJWT.mockResolvedValue(null);
      mockVerifyScopedJWT.mockResolvedValue(null);
      mockVerifyServiceToken.mockResolvedValue(null);

      const mockRestaurant = {
        id: 'rest-redis-error',
        apiKey: 'ts_api_key',
      };

      getMockRestaurantsFindFirst().mockResolvedValue(mockRestaurant);
      mockRedisIncr.mockRejectedValue(new Error('Redis connection failed'));

      const req = createMockRequest({
        headers: {
          'x-api-key': 'ts_api_key',
        },
      });

      const result = await validateRequest(req);

      // Should continue despite Redis error (fail-open for availability)
      expect(result.error).toBeUndefined();
      expect(result.context).toEqual({
        restaurantId: 'rest-redis-error',
      });
    });
  });

  // ============================================================================
  // validateRequest: Missing Authentication
  // ============================================================================

  describe('validateRequest - Missing Authentication', () => {
    it('should reject requests without authentication', async () => {
      const req = createMockRequest();

      const result = await validateRequest(req);

      expect(result.error).toBe('Missing authentication. Provide either Bearer token or x-api-key header');
      expect(result.status).toBe(401);
      expect(result.context).toBeUndefined();
    });
  });

  // ============================================================================
  // generateApiKey
  // ============================================================================

  describe('generateApiKey', () => {
    it('should generate API key with correct format', () => {
      const apiKey = generateApiKey();

      expect(apiKey).toMatch(/^ts_[a-z0-9]+$/);
      expect(apiKey.length).toBeGreaterThan(10);
    });

    it('should generate unique API keys', () => {
      const keys = new Set([generateApiKey(), generateApiKey(), generateApiKey()]);

      expect(keys.size).toBe(3);
    });
  });

  // ============================================================================
  // signWebhookPayload / verifyWebhookPayload
  // ============================================================================

  describe('Webhook Signing', () => {
    const testSecret = 'test-secret-key';
    const testPayload = JSON.stringify({ event: 'reservation.created', id: '123' });

    describe('signWebhookPayload', () => {
      it('should generate HMAC-SHA256 signature', async () => {
        const signature = await signWebhookPayload(testPayload, testSecret);

        expect(signature).toMatch(/^[a-f0-9]{64}$/); // 64 hex chars for SHA256
      });

      it('should generate different signatures for different payloads', async () => {
        const payload1 = JSON.stringify({ event: 'created' });
        const payload2 = JSON.stringify({ event: 'updated' });

        const sig1 = await signWebhookPayload(payload1, testSecret);
        const sig2 = await signWebhookPayload(payload2, testSecret);

        expect(sig1).not.toBe(sig2);
      });

      it('should generate same signature for same payload', async () => {
        const sig1 = await signWebhookPayload(testPayload, testSecret);
        const sig2 = await signWebhookPayload(testPayload, testSecret);

        expect(sig1).toBe(sig2);
      });
    });

    describe('verifyWebhookPayload', () => {
      it('should verify valid signature', async () => {
        const signature = await signWebhookPayload(testPayload, testSecret);
        const isValid = await verifyWebhookPayload(testPayload, signature, testSecret);

        expect(isValid).toBe(true);
      });

      it('should reject invalid signature', async () => {
        const isValid = await verifyWebhookPayload(testPayload, 'invalid-signature', testSecret);

        expect(isValid).toBe(false);
      });

      it('should reject signature with wrong secret', async () => {
        const signature = await signWebhookPayload(testPayload, testSecret);
        const isValid = await verifyWebhookPayload(testPayload, signature, 'wrong-secret');

        expect(isValid).toBe(false);
      });

      it('should reject when signature is missing', async () => {
        const isValid = await verifyWebhookPayload(testPayload, '', testSecret);

        expect(isValid).toBe(false);
      });

      it('should reject when secret is missing', async () => {
        const isValid = await verifyWebhookPayload(testPayload, 'some-signature', '');

        expect(isValid).toBe(false);
      });

      it('should reject malformed signature', async () => {
        const isValid = await verifyWebhookPayload(testPayload, 'not-hex-!!!', testSecret);

        expect(isValid).toBe(false);
      });
    });
  });

  // ============================================================================
  // signPayload / verifySignature (with timestamp)
  // ============================================================================

  describe('Timestamp-based Signing', () => {
    const testSecret = 'test-secret';
    const testPayload = 'test-payload-data';

    describe('signPayload', () => {
      it('should return signature and timestamp', async () => {
        const mockSignature = 'abc123def456';
        const mockTimestamp = Date.now();

        mockSecurityProviderSign.mockResolvedValue({
          signature: mockSignature,
          timestamp: mockTimestamp,
        });

        const result = await signPayload(testPayload, testSecret);

        expect(result).toEqual({
          signature: mockSignature,
          timestamp: mockTimestamp,
        });

        // Note: signPayload delegates to SecurityProvider.signPayload with only payload
        expect(mockSecurityProviderSign).toHaveBeenCalledWith(testPayload);
      });
    });

    describe('verifySignature', () => {
      it('should verify valid signature with timestamp', async () => {
        const now = Date.now();

        mockSecurityProviderVerify.mockResolvedValue(true);

        const isValid = await verifySignature(testPayload, 'valid-signature', now, testSecret);

        expect(isValid).toBe(true);
        expect(mockSecurityProviderVerify).toHaveBeenCalledWith(
          testPayload,
          'valid-signature',
          now
        );
      });

      it('should reject expired timestamps', async () => {
        const oldTimestamp = Date.now() - 400000; // 400 seconds ago (> 5 min)

        // SecurityProvider should reject expired timestamps
        mockSecurityProviderVerify.mockResolvedValue(false);

        const isValid = await verifySignature(testPayload, 'any-sig', oldTimestamp, testSecret);

        expect(isValid).toBe(false);
      });

      it('should reject missing signature', async () => {
        // SecurityProvider rejects empty signatures
        mockSecurityProviderVerify.mockResolvedValue(false);

        const isValid = await verifySignature(testPayload, '', Date.now(), testSecret);

        expect(isValid).toBe(false);
      });

      it('should reject missing timestamp', async () => {
        // SecurityProvider rejects zero/invalid timestamps
        mockSecurityProviderVerify.mockResolvedValue(false);

        const isValid = await verifySignature(testPayload, 'sig', 0, testSecret);

        expect(isValid).toBe(false);
      });
    });
  });

  // ============================================================================
  // Edge Cases and Error Handling
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle malformed JWT tokens gracefully', async () => {
      mockVerifyAsymmetricJWT.mockResolvedValue(null);
      mockVerifyScopedJWT.mockResolvedValue(null);
      mockVerifyServiceToken.mockResolvedValue(null);

      const req = createMockRequest({
        headers: {
          authorization: 'Bearer not.a.valid.jwt',
        },
      });

      const result = await validateRequest(req);

      // Should fall through to error response
      expect(result.error).toBe('Invalid or expired JWT token');
      expect(result.status).toBe(401);
    });

    it('should handle empty authorization header', async () => {
      const req = createMockRequest({
        headers: {
          authorization: '',
        },
      });

      const result = await validateRequest(req);

      expect(result.error).toBe('Missing authentication. Provide either Bearer token or x-api-key header');
      expect(result.status).toBe(401);
    });

    it('should handle Bearer prefix case insensitivity', async () => {
      mockVerifyAsymmetricJWT.mockResolvedValue(null);
      mockVerifyScopedJWT.mockResolvedValue(null);
      mockVerifyServiceToken.mockResolvedValue(null);

      const req = createMockRequest({
        headers: {
          authorization: 'bearer lowercase-prefix',
        },
      });

      const result = await validateRequest(req);

      // Should not match 'Bearer' (case sensitive)
      expect(result.error).toBe('Missing authentication. Provide either Bearer token or x-api-key header');
      expect(result.status).toBe(401);
    });
  });
});
