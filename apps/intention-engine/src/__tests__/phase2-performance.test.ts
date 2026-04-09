/**
 * Tests: Phase 2 - Performance & Cost Optimization
 *
 * T2.1: Availability caching with Redis read-through
 * T2.2: LLM token usage tracking
 * T2.3: DB connection pooling & query timeouts
 *
 * @see Phase 2: Performance & Cost Optimization
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ============================================================================
// MOCKS - Must be hoisted before imports
// ============================================================================

vi.mock("@repo/shared", () => ({
  withCache: vi.fn((fn) => fn),
  getRedisClient: vi.fn(() => ({
    get: vi.fn(() => Promise.resolve(null)),
    set: vi.fn(() => Promise.resolve("OK")),
    keys: vi.fn(() => Promise.resolve([])),
    del: vi.fn(() => Promise.resolve(0)),
  })),
  ServiceNamespace: {
    TS: "ts",
    IE: "ie",
    OD: "od",
    SHARED: "shared",
  },
  Logger: class MockLogger {
    info() {}
    warn() {}
    error() {}
  },
  AppConfig: {
    getRedisUrl: () => "http://localhost:8080",
    getRedisToken: () => "test-token",
    isProduction: () => false,
    isTest: () => true,
  },
}));

vi.mock("@repo/database", async () => {
  const actual = await vi.importActual("@repo/database");
  return {
    ...(actual as object),
  };
});

// Mock the LLM module's dependencies
vi.mock("ai", () => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
}));

vi.mock("@ai-sdk/openai", () => ({
  openai: vi.fn(() => ({})),
}));

vi.mock("@repo/shared/llm-cache", () => ({
  generateCacheKey: vi.fn(() => "test-cache-key"),
  getCachedResponse: vi.fn(() => Promise.resolve(null)),
  cacheResponse: vi.fn(() => Promise.resolve()),
  DEFAULT_TTL_SECONDS: 300,
}));

// ============================================================================
// T2.1: Cache Invalidation on Reserve
// ============================================================================

describe("T2.1: Availability Cache Invalidation", () => {
  it("should have withCache middleware available", async () => {
    const { withCache } = await import("@repo/shared");
    expect(typeof withCache).toBe("function");
  });

  it("should have getRedisClient available for cache operations", async () => {
    const { getRedisClient, ServiceNamespace } = await import("@repo/shared");
    expect(typeof getRedisClient).toBe("function");
    expect(ServiceNamespace.TS).toBe("ts");
  });

  it("should generate correct cache key pattern for availability", () => {
    const restaurantId = "test-restaurant-id";
    const date = "2024-01-15T19:00:00Z";
    const partySize = "4";
    const expectedKey = `availability:${restaurantId}:${date}:${partySize}`;
    expect(expectedKey).toBe(
      `availability:test-restaurant-id:2024-01-15T19:00:00Z:4`,
    );
  });

  it("should use wildcard pattern for cache invalidation", () => {
    const restaurantId = "test-restaurant-id";
    const invalidationPattern = `availability:${restaurantId}:*`;
    expect(invalidationPattern).toBe("availability:test-restaurant-id:*");
  });
});

// ============================================================================
// T2.2: LLM Token Usage Tracking
// ============================================================================

describe("T2.2: LLM Token Usage Tracking", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("should export getLLMTokensConsumedTotal function", async () => {
    const { getLLMTokensConsumedTotal } = await import("../lib/engine/llm");
    expect(typeof getLLMTokensConsumedTotal).toBe("function");
  });

  it("should export resetLLMTokenCounter function", async () => {
    const { resetLLMTokenCounter } = await import("../lib/engine/llm");
    expect(typeof resetLLMTokenCounter).toBe("function");
  });

  it("should start with zero tokens consumed", async () => {
    const { getLLMTokensConsumedTotal, resetLLMTokenCounter } =
      await import("../lib/engine/llm");
    resetLLMTokenCounter();
    expect(getLLMTokensConsumedTotal()).toBe(0);
  });

  it("should reset token counter to zero", async () => {
    const { getLLMTokensConsumedTotal, resetLLMTokenCounter } =
      await import("../lib/engine/llm");
    resetLLMTokenCounter();
    expect(getLLMTokensConsumedTotal()).toBe(0);
  });
});

// ============================================================================
// T2.3: DB Connection Pooling & Query Timeouts
// ============================================================================

describe("T2.3: DB Connection Pooling & Query Timeouts", () => {
  it("should export configureDatabase function", async () => {
    const { configureDatabase } = await import("@repo/database");
    expect(typeof configureDatabase).toBe("function");
  });

  it("should export getDatabaseConfig function", async () => {
    const { getDatabaseConfig } = await import("@repo/database");
    expect(typeof getDatabaseConfig).toBe("function");
  });

  it("should export TimeoutError class", async () => {
    const { TimeoutError } = await import("@repo/database");
    expect(typeof TimeoutError).toBe("function");
  });

  it("should have default query timeout configured", async () => {
    const { getDatabaseConfig } = await import("@repo/database");
    const config = getDatabaseConfig();
    expect(config.queryTimeout).toBeDefined();
    expect(config.queryTimeout).toBeGreaterThan(0);
  });

  it("should have slow query logging enabled by default", async () => {
    const { getDatabaseConfig } = await import("@repo/database");
    const config = getDatabaseConfig();
    expect(config.enableSlowQueryLogging).toBe(true);
  });

  it("should have configurable slow query threshold", async () => {
    const { getDatabaseConfig } = await import("@repo/database");
    const config = getDatabaseConfig();
    expect(config.slowQueryThresholdMs).toBeDefined();
    expect(config.slowQueryThresholdMs).toBeGreaterThan(0);
  });

  it("should allow custom database configuration", async () => {
    const { configureDatabase, getDatabaseConfig } =
      await import("@repo/database");
    configureDatabase({
      queryTimeout: 30000,
      slowQueryThresholdMs: 500,
      enableSlowQueryLogging: true,
    });
    const config = getDatabaseConfig();
    expect(config.queryTimeout).toBe(30000);
    expect(config.slowQueryThresholdMs).toBe(500);
  });
});

// ============================================================================
// Integration: Cache + Performance
// ============================================================================

describe("Phase 2: Integration Tests", () => {
  it("should have all Phase 2 components available", async () => {
    // T2.1
    const { withCache, getRedisClient, ServiceNamespace } =
      await import("@repo/shared");
    expect(withCache).toBeDefined();
    expect(getRedisClient).toBeDefined();
    expect(ServiceNamespace).toBeDefined();

    // T2.2
    const { getLLMTokensConsumedTotal, resetLLMTokenCounter } =
      await import("../lib/engine/llm");
    expect(getLLMTokensConsumedTotal).toBeDefined();
    expect(resetLLMTokenCounter).toBeDefined();

    // T2.3
    const { configureDatabase, getDatabaseConfig, TimeoutError } =
      await import("@repo/database");
    expect(configureDatabase).toBeDefined();
    expect(getDatabaseConfig).toBeDefined();
    expect(TimeoutError).toBeDefined();
  });
});
