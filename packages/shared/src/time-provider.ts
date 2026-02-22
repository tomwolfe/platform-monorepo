/**
 * Time Provider Abstraction
 *
 * Enables deterministic testing of time-based logic by abstracting Date.now()
 * behind an injectable interface.
 *
 * Problem Solved:
 * - Tests relying on real setTimeout delays are slow, flaky, and expensive
 * - Production code should use real time, tests should use fake time
 *
 * Usage:
 * ```typescript
 * // In production
 * const machine = new WorkflowMachine(executionId, executor, {
 *   timeProvider: new RealTimeProvider(),
 * });
 *
 * // In tests
 * import { FakeTimeProvider } from '@repo/shared';
 * const fakeTime = new FakeTimeProvider();
 * const machine = new WorkflowMachine(executionId, executor, {
 *   timeProvider: fakeTime,
 * });
 *
 * // Advance time instantly in tests
 * fakeTime.advance(10000); // Jump forward 10 seconds
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

// ============================================================================
// TIME PROVIDER INTERFACE
// ============================================================================

export interface TimeProvider {
  /**
   * Get current timestamp in milliseconds since epoch
   */
  now(): number;

  /**
   * Get current Date object
   */
  nowDate(): Date;

  /**
   * Sleep for specified milliseconds
   * In tests, this can be instantaneous
   */
  sleep(ms: number): Promise<void>;
}

// ============================================================================
// REAL TIME PROVIDER
// Production implementation using real Date
// ============================================================================

export class RealTimeProvider implements TimeProvider {
  now(): number {
    return Date.now();
  }

  nowDate(): Date {
    return new Date();
  }

  async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============================================================================
// FAKE TIME PROVIDER
// Test implementation with controllable time
// ============================================================================

export class FakeTimeProvider implements TimeProvider {
  private currentTime: number;
  private timers: Array<{
    callback: () => void;
    delay: number;
    scheduledAt: number;
    id: number;
  }> = [];
  private nextTimerId = 1;

  constructor(startTime: number = Date.now()) {
    this.currentTime = startTime;
  }

  /**
   * Get current fake timestamp
   */
  now(): number {
    return this.currentTime;
  }

  /**
   * Get current fake Date
   */
  nowDate(): Date {
    return new Date(this.currentTime);
  }

  /**
   * Advance time by specified milliseconds
   * Executes any timers that would have fired during this period
   *
   * @param ms - Milliseconds to advance
   */
  advance(ms: number): void {
    const targetTime = this.currentTime + ms;

    // Execute timers in order as we advance time
    while (this.currentTime < targetTime) {
      // Find next timer to execute
      const nextTimer = this.timers.find(
        t => t.scheduledAt + t.delay <= targetTime && t.scheduledAt + t.delay > this.currentTime
      );

      if (!nextTimer) {
        // No more timers, just jump to target time
        this.currentTime = targetTime;
        break;
      }

      // Advance to timer execution time
      this.currentTime = nextTimer.scheduledAt + nextTimer.delay;

      // Execute timer callback
      nextTimer.callback();

      // Remove timer from list
      this.timers = this.timers.filter(t => t.id !== nextTimer.id);
    }
  }

  /**
   * Set time to specific timestamp
   */
  setTime(timestamp: number): void {
    this.currentTime = timestamp;
  }

  /**
   * Sleep implementation - returns immediately in fake time
   * Timer will be executed when advance() is called
   */
  async sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.timers.push({
        callback: resolve,
        delay: ms,
        scheduledAt: this.currentTime,
        id: this.nextTimerId++,
      });
    });
  }

  /**
   * Run all pending timers immediately
   */
  runAllTimers(): void {
    // Advance by a very large amount to trigger all timers
    this.advance(1000000000);
  }

  /**
   * Get number of pending timers
   */
  getPendingTimerCount(): number {
    return this.timers.length;
  }

  /**
   * Reset to initial time
   */
  reset(startTime?: number): void {
    this.currentTime = startTime ?? Date.now();
    this.timers = [];
    this.nextTimerId = 1;
  }
}

// ============================================================================
// GLOBAL TIME PROVIDER
// Singleton for use across the application
// ============================================================================

let globalTimeProvider: TimeProvider = new RealTimeProvider();

/**
 * Get the global time provider
 */
export function getTimeProvider(): TimeProvider {
  return globalTimeProvider;
}

/**
 * Set the global time provider
 * Use this in test setup to inject fake time
 */
export function setTimeProvider(provider: TimeProvider): void {
  globalTimeProvider = provider;
}

/**
 * Reset global time provider to real time
 * Use this in test cleanup
 */
export function resetTimeProvider(): void {
  globalTimeProvider = new RealTimeProvider();
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Create a time provider for testing
 * Convenience function that returns a FakeTimeProvider
 */
export function createFakeTimeProvider(startTime?: number): FakeTimeProvider {
  return new FakeTimeProvider(startTime);
}
