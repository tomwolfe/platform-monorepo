/**
 * Vitest Setup File for TableStack
 *
 * Global test configuration, mocks, and setup for table-stack tests.
 *
 * @see Phase 1.1: Testing Infrastructure
 * @see Task 5: Clean Up vitest-setup.ts - Moved global mocks to __mocks__ directory
 */

import { vi, beforeEach, afterEach, afterAll } from "vitest";

// ============================================================================
// MOCKS - MUST BE HOISTED BEFORE IMPORTS
//
// These mocks now delegate to centralized mock factories in __mocks__/
// to reduce duplication and improve maintainability.
// ============================================================================

/**
 * Mock server-only to avoid Client Component errors in tests
 */
vi.mock("server-only", () => ({}));

/**
 * Mock @repo/mcp-protocol to prevent circular dependency issues.
 * This module instantiates Logger at module load time, which breaks
 * tests if the Logger mock isn't applied first.
 * Complete mock - does NOT load the real module.
 */
vi.mock("@repo/mcp-protocol", () => ({
  COMPENSATIONS: {},
  needsCompensation: vi.fn(() => false),
  getCompensation: vi.fn(),
  mapCompensationParameters: vi.fn(),
  IDEMPOTENT_TOOLS: [],
  DB_REFLECTED_SCHEMAS: {},
  getTypedToolEntry: vi.fn(),
  validateToolParams: vi.fn(() => ({ valid: true })),
  AllToolsMap: {},
}));

/**
 * Mock @upstash/ratelimit - missing dependency
 */
vi.mock("@upstash/ratelimit", () => {
  const mockRatelimit = {
    limit: vi.fn().mockResolvedValue({
      success: true,
      limit: 100,
      remaining: 99,
      reset: Date.now() + 60000,
    }),
  };
  return {
    Ratelimit: {
      token: vi.fn(() => mockRatelimit),
    },
  };
});

/**
 * Mock @opentelemetry/api - missing dependency
 */
vi.mock("@opentelemetry/api", () => ({
  trace: {
    getTracer: vi.fn(() => ({
      startSpan: vi.fn(() => ({
        setAttributes: vi.fn(),
        recordException: vi.fn(),
        end: vi.fn(),
        spanContext: () => ({ traceId: "test-trace", spanId: "test-span" }),
      })),
      startActiveSpan: vi.fn((_name, fn) =>
        fn({
          setAttributes: vi.fn(),
          recordException: vi.fn(),
          end: vi.fn(),
          spanContext: () => ({ traceId: "test-trace", spanId: "test-span" }),
        }),
      ),
    })),
    setGlobalTracerProvider: vi.fn(),
    getSpan: vi.fn(),
    getActiveSpan: vi.fn(),
  },
  context: {
    active: vi.fn(() => ({})),
    with: vi.fn((_ctx, fn) => fn()),
  },
  SpanStatusCode: {
    OK: 0,
    ERROR: 1,
  },
}));

/**
 * Mock @repo/database for integration tests
 * FIX: Properly mock Drizzle's transaction pattern
 * Delegates to centralized mock in __mocks__/@repo/database.ts
 */
vi.mock("@repo/database", async () => {
  const { createMockDatabase } = await import("./__mocks__/@repo/database");
  return createMockDatabase();
});

/**
 * Mock @repo/shared redis client and utilities
 * Delegates to centralized mock in __mocks__/@repo/shared.ts
 */
vi.mock("@repo/shared", async () => {
  const { createMockShared } = await import("./__mocks__/@repo/shared");
  return createMockShared();
});

/**
 * Mock tablestack internal modules
 * Delegates to centralized mock in __mocks__/@tablestack/lib.ts
 */
vi.mock("@tablestack/lib/notifications", async () => {
  const { MockNotifyService } = await import("./__mocks__/@tablestack/lib");
  return { NotifyService: MockNotifyService };
});

vi.mock("@tablestack/lib/auth", async () => {
  const { MockAuth } = await import("./__mocks__/@tablestack/lib");
  return MockAuth;
});

vi.mock("@tablestack/lib/redis", async () => {
  const { MockRedis } = await import("./__mocks__/@tablestack/lib");
  return MockRedis;
});

/**
 * Mock Next.js server modules
 */
vi.mock("next/server", async (importActual) => {
  const actual = await importActual();
  return {
    ...(actual as Record<string, unknown>),
    NextRequest: function (url: string | URL, init?: RequestInit) {
      return new Request(typeof url === "string" ? url : url.toString(), init);
    },
    NextResponse: {
      json: vi.fn((data: Record<string, unknown>, init?: ResponseInit) => {
        return new Response(JSON.stringify(data), {
          ...init,
          headers: {
            ...init?.headers,
            "content-type": "application/json",
          },
        });
      }),
      redirect: vi.fn((url: string, status?: number) => {
        return new Response(null, {
          status: status || 302,
          headers: {
            location: url,
          },
        });
      }),
    },
  };
});

/**
 * Mock serverless timeout
 */
vi.mock("@repo/shared/middleware/serverless-timeout", () => ({
  withServerlessTimeout: vi.fn(
    (handler: (req: Request) => Promise<Response>) => handler,
  ),
}));

// ============================================================================
// IMPORTS (after mocks)
// ============================================================================

import { cleanupTestDatabase } from "@repo/shared/testing";

// ============================================================================
// GLOBAL TIMEOUT CONFIGURATION
// ============================================================================

// Set global test timeout to 30 seconds for integration tests
vi.setConfig({
  testTimeout: 30000,
  hookTimeout: 30000,
});

// ============================================================================
// ENVIRONMENT VARIABLES
// ============================================================================

// Set test environment variables
process.env.NODE_ENV = "test";
process.env.TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  "postgresql://test:test@localhost:5432/test_db";
process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
process.env.REDIS_URL = process.env.REDIS_URL || "http://localhost:6379";

// Mock sensitive environment variables for tests
process.env.INTERNAL_SYSTEM_KEY = "test-system-key";
process.env.UPSTASH_REDIS_REST_URL = "http://localhost:6379";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

// ============================================================================
// TEST CLEANUP
// ============================================================================

/**
 * Reset all mocks and module state before each test to ensure isolation.
 * This prevents state leakage between tests (e.g., memoized values, singleton instances).
 */
beforeEach(() => {
  vi.resetAllMocks();
});

/**
 * Cleanup after each test to prevent test pollution
 */
afterEach(async () => {
  vi.clearAllMocks();
});

/**
 * Global cleanup after all tests
 */
afterAll(async () => {
  // Attempt to cleanup test database (will fail gracefully if not connected)
  try {
    await cleanupTestDatabase();
  } catch (error) {
    // Ignore cleanup errors in test environment
    console.warn("Test database cleanup skipped:", error);
  }
});

// ============================================================================
// TYPE DECLARATIONS
// ============================================================================

declare global {
  /**
   * Wait for a specified number of milliseconds
   */
  function waitFor(ms: number): Promise<void>;

  /**
   * Create a promise that never resolves
   */
  function neverResolves(): Promise<never>;

  /**
   * Suppress console output during tests
   */
  function suppressConsole(): void;

  /**
   * Restore console output
   */
  function restoreConsole(): void;
}

// ============================================================================
// EXPORTS
// ============================================================================

export {};
