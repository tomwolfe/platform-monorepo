/**
 * Integration Test Utilities
 *
 * Retry, timeout, and reliability helpers for integration tests.
 *
 * @see T6: Enhance Integration Test Reliability
 */

// ============================================================================
// RETRY WITH BACKOFF
// ============================================================================

export interface RetryOptions {
  /** Maximum number of attempts (default: 3) */
  maxAttempts?: number;
  /** Base delay in ms (default: 100) */
  baseDelay?: number;
  /** Maximum delay cap in ms (default: 5000) */
  maxDelay?: number;
  /** Exponential backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Only retry on these error messages/patterns */
  retryOn?: string[] | RegExp[];
}

/**
 * Execute an async function with retry and exponential backoff.
 *
 * Useful for flaky integration tests (network timeouts, race conditions).
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => fetchDatabaseRecords(),
 *   { maxAttempts: 3, baseDelay: 200 }
 * );
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelay = 100,
    maxDelay = 5000,
    backoffMultiplier = 2,
    retryOn,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      if (attempt < maxAttempts && shouldRetry(lastError, retryOn)) {
        const delay = Math.min(
          baseDelay * backoffMultiplier ** (attempt - 1),
          maxDelay,
        );
        await sleep(delay);
      } else {
        throw lastError;
      }
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError ?? new Error("Retry exhausted without capturing error");
}

function shouldRetry(error: Error, retryOn?: string[] | RegExp[]): boolean {
  if (!retryOn) return true; // Retry all errors if no filter specified

  return retryOn.some((pattern) => {
    if (typeof pattern === "string") {
      return error.message.includes(pattern);
    }
    return pattern.test(error.message);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// TIMEOUT WRAPPER
// ============================================================================

/**
 * Execute an async function with a strict timeout.
 *
 * @example
 * ```ts
 * const result = await withTimeout(
 *   () => slowOperation(),
 *   5000 // 5 second timeout
 * );
 * ```
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref(); // Don't keep Node.js alive
  });

  return Promise.race([fn(), timeoutPromise]);
}

// ============================================================================
// EVENTUALLY ASSERTION
// ============================================================================

/**
 * Wait until an assertion passes or timeout is reached.
 *
 * Useful for eventual consistency scenarios (async replication, cache warmup).
 *
 * @example
 * ```ts
 * await eventually(
 *   () => expect(cache.get("key")).toBe("value"),
 *   { timeout: 5000, interval: 200 }
 * );
 * ```
 */
export async function eventually(
  assertion: () => void | Promise<void>,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const { timeout = 5000, interval = 200 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      await assertion();
      return; // Assertion passed
    } catch {
      if (Date.now() - startTime >= timeout) {
        throw new Error(`Assertion did not pass within ${timeout}ms timeout`);
      }
      await sleep(interval);
    }
  }
}

// ============================================================================
// DETERMINISTIC WAIT
// ============================================================================

/**
 * Wait for a condition to become true within a timeout.
 *
 * @example
 * ```ts
 * await waitForCondition(
 *   () => redis.get("flag") === "ready",
 *   { timeout: 3000 }
 * );
 * ```
 */
export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const { timeout = 5000, interval = 100 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (await predicate()) return;
    await sleep(interval);
  }

  throw new Error(`Condition not met within ${timeout}ms timeout`);
}

// ============================================================================
// TEST CLEANUP HELPERS
// ============================================================================

/**
 * Run cleanup logic that won't fail the test if it errors.
 * Useful for teardown that might encounter partially-deleted resources.
 *
 * @example
 * ```ts
 * afterAll(async () => {
 *   await safeCleanup(() => db.delete(testData));
 * });
 * ```
 */
export async function safeCleanup(
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch {
    // Ignore cleanup errors - resources may have been partially cleaned up
  }
}

/**
 * Generate a unique test ID to avoid collisions between parallel runs.
 */
export function testId(prefix: string = "test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
