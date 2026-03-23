/**
 * Vitest Setup File for TableStack
 *
 * Global test configuration, mocks, and setup for table-stack tests.
 * This file is automatically loaded by Vitest before running tests.
 *
 * @see vitest.config.ts at project root
 */

import { vi, beforeEach, afterEach, afterAll } from 'vitest';
import { cleanupTestDatabase } from '../test/setup';

// ============================================================================
// GLOBAL TIMEOUT CONFIGURATION
// ============================================================================

// Set global test timeout to 30 seconds for integration tests
vi.setConfig({
  testTimeout: 30000,
  hookTimeout: 30000,
});

// ============================================================================
// GLOBAL MOCKS
// ============================================================================

/**
 * Mock Next.js server modules
 */
vi.mock('next/server', async (importActual) => {
  const actual = await importActual();
  return {
    ...(actual as any),
    NextRequest: function(url: string | URL, init?: RequestInit) {
      return new Request(typeof url === 'string' ? url : url.toString(), init);
    },
    NextResponse: {
      json: vi.fn((data: any, init?: ResponseInit) => {
        return new Response(JSON.stringify(data), {
          ...init,
          headers: {
            ...init?.headers,
            'content-type': 'application/json',
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
 * Mock date-fns to use consistent test dates
 */
vi.mock('date-fns', async () => {
  const actual = await vi.importActual('date-fns');
  return {
    ...(actual as any),
    // Keep actual implementations for now
  };
});

/**
 * Mock date-fns-tz for timezone handling
 */
vi.mock('date-fns-tz', async () => {
  const actual = await vi.importActual('date-fns-tz');
  return {
    ...(actual as any),
    // Keep actual implementations for now
  };
});

// ============================================================================
// ENVIRONMENT VARIABLES
// ============================================================================

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://test:test@localhost:5432/test_db';
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
process.env.REDIS_URL = process.env.REDIS_URL || 'http://localhost:6379';

// Mock sensitive environment variables for tests
process.env.INTERNAL_SYSTEM_KEY = 'test-system-key';
process.env.UPSTASH_REDIS_REST_URL = 'http://localhost:6379';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

// ============================================================================
// TEST CLEANUP
// ============================================================================

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
    console.warn('Test database cleanup skipped:', error);
  }
});

// ============================================================================
// GLOBAL TEST UTILITIES
// ============================================================================

/**
 * Wait for a specified number of milliseconds
 * Useful for testing async operations and race conditions
 */
globalThis.waitFor = (ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Create a promise that never resolves
 * Useful for testing timeout behavior
 */
globalThis.neverResolves = (): Promise<never> => {
  return new Promise(() => {});
};

/**
 * Suppress console output during tests
 * Useful for reducing noise in test output
 */
globalThis.suppressConsole = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
};

/**
 * Restore console output
 */
globalThis.restoreConsole = () => {
  vi.restoreAllMocks();
};

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
