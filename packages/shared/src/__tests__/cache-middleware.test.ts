/**
 * Unit Tests: Cache Middleware
 *
 * Tests for packages/shared/src/cache-middleware.ts
 *
 * @see Phase 2.1: Caching Strategy
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// MOCKS (must be at top level for hoisting)
// ============================================================================

// Mock Redis client
const mockRedisClient = {
  get: vi.fn().mockResolvedValue(null),
  setex: vi.fn().mockResolvedValue('OK'),
  del: vi.fn().mockResolvedValue(1),
  sadd: vi.fn().mockResolvedValue(1),
  expire: vi.fn().mockResolvedValue(1),
  smembers: vi.fn().mockResolvedValue([]),
  keys: vi.fn().mockResolvedValue([]),
  info: vi.fn().mockResolvedValue(''),
};

vi.mock('../redis', () => ({
  getRedisClient: vi.fn(() => mockRedisClient),
  ServiceNamespace: {
    CACHE: 'cache',
  },
  getNamespacePrefix: vi.fn(),
  wrapWithPrefix: vi.fn(),
}));

// Mock Logger
vi.mock('../logger', () => ({
  Logger: class MockLogger {
    debug = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    constructor() {}
  },
}));

// Import after mocks
import {
  withCache,
  invalidateCache,
  invalidateCacheByTag,
  invalidateCacheByPattern,
  generateCacheKey,
  getTagKey,
  type CacheOptions,
} from '../cache-middleware';

// ============================================================================
// TEST HELPERS
// ============================================================================

/**
 * Create mock request
 */
function createMockRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
} = {}) {
  const { method = 'GET', url = 'http://localhost:3000/api/test', headers = {} } = options;

  return new Request(url, {
    method,
    headers: new Headers(headers),
  });
}

/**
 * Create mock response
 */
function createMockResponse(data: any, status: number = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Reset all mocks
 */
function resetMocks() {
  vi.clearAllMocks();
  mockRedisClient.get.mockResolvedValue(null);
  mockRedisClient.setex.mockResolvedValue('OK');
  mockRedisClient.del.mockResolvedValue(1);
  mockRedisClient.sadd.mockResolvedValue(1);
  mockRedisClient.expire.mockResolvedValue(1);
  mockRedisClient.smembers.mockResolvedValue([]);
  mockRedisClient.keys.mockResolvedValue([]);
  mockRedisClient.info.mockResolvedValue('');
}

// ============================================================================
// UNIT TESTS
// ============================================================================

describe('Cache Middleware', () => {
  beforeEach(() => {
    resetMocks();
  });

  // ============================================================================
  // Cache Key Generation
  // ============================================================================

  describe('generateCacheKey', () => {
    it('should generate cache key from request', () => {
      const req = createMockRequest({
        method: 'GET',
        url: 'http://localhost:3000/api/availability?restaurantId=123',
      });

      const key = generateCacheKey(req);

      expect(key).toBe('cache:GET:/api/availability?restaurantId=123');
    });

    it('should include prefix when provided', () => {
      const req = createMockRequest({
        method: 'GET',
        url: 'http://localhost:3000/api/test',
      });

      const key = generateCacheKey(req, 'availability');

      expect(key).toBe('availability:GET:/api/test');
    });

    it('should handle requests without query params', () => {
      const req = createMockRequest({
        method: 'GET',
        url: 'http://localhost:3000/api/health',
      });

      const key = generateCacheKey(req);

      expect(key).toBe('cache:GET:/api/health');
    });
  });

  describe('getTagKey', () => {
    it('should generate tag key', () => {
      const tagKey = getTagKey('restaurant-123');
      expect(tagKey).toBe('cache:tag:restaurant-123');
    });
  });

  // ============================================================================
  // withCache Middleware
  // ============================================================================

  describe('withCache', () => {
    it('should return cached response on cache hit', async () => {
      const cachedData = { available: true, tables: 5 };
      mockRedisClient.get.mockResolvedValue(JSON.stringify(cachedData));

      const handler = vi.fn().mockResolvedValue(createMockResponse({ available: false }));
      const cacheOptions: CacheOptions = { ttl: 300 };

      const cachedHandler = withCache(handler, cacheOptions);
      const req = createMockRequest();

      const response = await cachedHandler(req);
      const data = await response.json();

      expect(data).toEqual(cachedData);
      expect(response.headers.get('X-Cache')).toBe('HIT');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should call handler and cache response on cache miss', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.setex.mockResolvedValue('OK');
      mockRedisClient.sadd.mockResolvedValue(1);
      mockRedisClient.expire.mockResolvedValue(1);

      const responseData = { available: true, tables: 5 };
      const handler = vi.fn().mockResolvedValue(createMockResponse(responseData));
      const cacheOptions: CacheOptions = {
        ttl: 300,
        tags: ['availability'],
      };

      const cachedHandler = withCache(handler, cacheOptions);
      const req = createMockRequest();

      const response = await cachedHandler(req);
      const data = await response.json();

      expect(data).toEqual(responseData);
      expect(response.headers.get('X-Cache')).toBe('MISS');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockRedisClient.setex).toHaveBeenCalled();
    });

    it('should skip cache when skip function returns true', async () => {
      const handler = vi.fn().mockResolvedValue(createMockResponse({ data: 'test' }));
      const cacheOptions: CacheOptions = {
        ttl: 300,
        skip: () => true,
      };

      const cachedHandler = withCache(handler, cacheOptions);
      const req = createMockRequest();

      await cachedHandler(req);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockRedisClient.get).not.toHaveBeenCalled();
    });

    it('should use custom key generator when provided', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const customKey = 'custom-cache-key';
      const generateKey = vi.fn().mockReturnValue(customKey);

      const handler = vi.fn().mockResolvedValue(createMockResponse({ data: 'test' }));
      const cacheOptions: CacheOptions = {
        ttl: 300,
        generateKey,
      };

      const cachedHandler = withCache(handler, cacheOptions);
      const req = createMockRequest();

      await cachedHandler(req);

      expect(generateKey).toHaveBeenCalledWith(req);
      expect(mockRedisClient.get).toHaveBeenCalledWith(customKey);
    });

    it('should only cache successful responses when onlySuccess is true', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const handler = vi.fn().mockResolvedValue(createMockResponse({ error: 'Not found' }, 404));
      const cacheOptions: CacheOptions = {
        ttl: 300,
        onlySuccess: true,
      };

      const cachedHandler = withCache(handler, cacheOptions);
      const req = createMockRequest();

      await cachedHandler(req);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockRedisClient.setex).not.toHaveBeenCalled();
    });

    it('should cache error responses when onlySuccess is false', async () => {
      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.setex.mockResolvedValue('OK');

      const handler = vi.fn().mockResolvedValue(createMockResponse({ error: 'Not found' }, 404));
      const cacheOptions: CacheOptions = {
        ttl: 300,
        onlySuccess: false,
      };

      const cachedHandler = withCache(handler, cacheOptions);
      const req = createMockRequest();

      await cachedHandler(req);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockRedisClient.setex).toHaveBeenCalled();
    });

    it('should handle handler errors gracefully', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const error = new Error('Handler failed');
      const handler = vi.fn().mockRejectedValue(error);
      const cacheOptions: CacheOptions = { ttl: 300 };

      const cachedHandler = withCache(handler, cacheOptions);
      const req = createMockRequest();

      await expect(cachedHandler(req)).rejects.toThrow('Handler failed');
      expect(mockRedisClient.setex).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Cache Invalidation
  // ============================================================================

  describe('invalidateCache', () => {
    it('should invalidate cache by key', async () => {
      mockRedisClient.del.mockResolvedValue(1);

      await invalidateCache('cache:GET:/api/test');

      expect(mockRedisClient.del).toHaveBeenCalledWith('cache:GET:/api/test');
    });
  });

  describe('invalidateCacheByTag', () => {
    it('should invalidate all keys with tag', async () => {
      const tagKeys = ['cache:key1', 'cache:key2', 'cache:key3'];
      mockRedisClient.smembers.mockResolvedValue(tagKeys);
      mockRedisClient.del.mockResolvedValue(tagKeys.length);

      await invalidateCacheByTag('restaurant-123');

      expect(mockRedisClient.smembers).toHaveBeenCalledWith('cache:tag:restaurant-123');
      expect(mockRedisClient.del).toHaveBeenCalledWith(...tagKeys);
      expect(mockRedisClient.del).toHaveBeenCalledWith('cache:tag:restaurant-123');
    });

    it('should handle empty tag', async () => {
      mockRedisClient.smembers.mockResolvedValue([]);

      await invalidateCacheByTag('empty-tag');

      expect(mockRedisClient.smembers).toHaveBeenCalledWith('cache:tag:empty-tag');
      // The implementation still deletes the tag key itself
      expect(mockRedisClient.del).toHaveBeenCalledWith('cache:tag:empty-tag');
    });
  });

  describe('invalidateCacheByPattern', () => {
    it('should invalidate all keys matching pattern', async () => {
      const patternKeys = ['cache:availability:1', 'cache:availability:2'];
      mockRedisClient.keys.mockResolvedValue(patternKeys);
      mockRedisClient.del.mockResolvedValue(patternKeys.length);

      await invalidateCacheByPattern('cache:availability:*');

      expect(mockRedisClient.keys).toHaveBeenCalledWith('cache:availability:*');
      expect(mockRedisClient.del).toHaveBeenCalledWith(...patternKeys);
    });

    it('should handle empty pattern match', async () => {
      mockRedisClient.keys.mockResolvedValue([]);

      await invalidateCacheByPattern('cache:nonexistent:*');

      expect(mockRedisClient.keys).toHaveBeenCalledWith('cache:nonexistent:*');
      expect(mockRedisClient.del).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Integration Tests
  // ============================================================================

  describe('Cache Flow', () => {
    it('should cache and invalidate correctly', async () => {
      // First request - cache miss
      mockRedisClient.get.mockResolvedValue(null);
      mockRedisClient.setex.mockResolvedValue('OK');
      mockRedisClient.sadd.mockResolvedValue(1);
      mockRedisClient.expire.mockResolvedValue(1);

      const handler = vi.fn().mockResolvedValue(createMockResponse({ data: 'fresh' }));
      const cacheOptions: CacheOptions = {
        ttl: 300,
        tags: ['test-tag'],
      };

      const cachedHandler = withCache(handler, cacheOptions);
      const req = createMockRequest();

      // First request
      const response1 = await cachedHandler(req);
      const data1 = await response1.json();

      expect(data1).toEqual({ data: 'fresh' });
      expect(response1.headers.get('X-Cache')).toBe('MISS');
      expect(handler).toHaveBeenCalledTimes(1);

      // Reset handler mock to verify it's not called again
      handler.mockClear();

      // Second request - cache hit
      mockRedisClient.get.mockResolvedValue(JSON.stringify({ data: 'fresh' }));

      const response2 = await cachedHandler(req);
      const data2 = await response2.json();

      expect(data2).toEqual({ data: 'fresh' });
      expect(response2.headers.get('X-Cache')).toBe('HIT');
      expect(handler).not.toHaveBeenCalled();

      // Invalidate cache
      mockRedisClient.smembers.mockResolvedValue(['cache:GET:/api/test']);
      mockRedisClient.del.mockResolvedValue(1);

      await invalidateCacheByTag('test-tag');

      expect(mockRedisClient.del).toHaveBeenCalledWith('cache:GET:/api/test');

      // Third request - cache miss after invalidation
      mockRedisClient.get.mockResolvedValue(null);
      handler.mockResolvedValue(createMockResponse({ data: 'updated' }));

      const response3 = await cachedHandler(req);
      const data3 = await response3.json();

      expect(data3).toEqual({ data: 'updated' });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
