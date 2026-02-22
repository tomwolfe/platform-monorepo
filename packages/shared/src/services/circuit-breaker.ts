/**
 * Circuit Breaker for External API Calls
 *
 * Implements the circuit breaker pattern to prevent cascade failures
 * when external services (LLM APIs, MCP servers, databases) are unhealthy.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests fail fast
 * - HALF_OPEN: Testing if service recovered
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { EventEmitter } from 'events';

// ============================================================================
// CIRCUIT BREAKER STATE
// ============================================================================

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerStats {
  /** Total requests */
  totalRequests: number;
  /** Successful requests */
  successfulRequests: number;
  /** Failed requests */
  failedRequests: number;
  /** Rejected requests (circuit open) */
  rejectedRequests: number;
  /** Timeout requests */
  timeoutRequests: number;
  /** Current failure count */
  currentFailures: number;
  /** Consecutive successes (for half-open recovery) */
  consecutiveSuccesses: number;
  /** Last state change timestamp */
  lastStateChange: number;
  /** Total time in each state */
  timeInState: Record<CircuitState, number>;
}

// ============================================================================
// CIRCUIT BREAKER CONFIGURATION
// ============================================================================

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time in ms before attempting recovery (OPEN -> HALF_OPEN) */
  resetTimeoutMs: number;
  /** Number of successes in HALF_OPEN to close circuit */
  successThreshold: number;
  /** Request timeout in ms */
  requestTimeoutMs: number;
  /** Monitor half-open request health */
  monitorHalfOpenRequests: boolean;
  /** Error codes that should NOT trip the circuit */
  ignoredErrors: string[];
  /** Enable debug logging */
  debug: boolean;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30000,
  successThreshold: 3,
  requestTimeoutMs: 10000,
  monitorHalfOpenRequests: true,
  ignoredErrors: ['CLIENT_ERROR', 'VALIDATION_ERROR', 'NOT_FOUND'],
  debug: false,
};

// ============================================================================
// CIRCUIT BREAKER EVENTS
// ============================================================================

export interface CircuitBreakerEvents {
  stateChange: (from: CircuitState, to: CircuitState, reason: string) => void;
  failure: (error: Error, failureCount: number) => void;
  success: () => void;
  reject: () => void;
  halfOpenRequest: () => void;
}

// ============================================================================
// CIRCUIT BREAKER CLASS
// ============================================================================

export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private consecutiveSuccesses = 0;
  private lastFailureTime = 0;
  private nextAttempt = 0;
  private stats: CircuitBreakerStats;
  private config: CircuitBreakerConfig;
  private name: string;

  constructor(
    name: string,
    config: Partial<CircuitBreakerConfig> = {}
  ) {
    super();
    this.name = name;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stats = this.createInitialStats();
  }

  private createInitialStats(): CircuitBreakerStats {
    return {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rejectedRequests: 0,
      timeoutRequests: 0,
      currentFailures: 0,
      consecutiveSuccesses: 0,
      lastStateChange: Date.now(),
      timeInState: {
        CLOSED: 0,
        OPEN: 0,
        HALF_OPEN: 0,
      },
    };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.stats.totalRequests++;
    const startTime = Date.now();

    // Check if we should allow the request
    if (!this.allowRequest()) {
      this.stats.rejectedRequests++;
      this.emit('reject');
      
      throw new CircuitBreakerOpenError(
        `Circuit breaker '${this.name}' is OPEN`,
        this.getNextRetryTime()
      );
    }

    // Track half-open requests
    if (this.state === 'HALF_OPEN') {
      this.emit('halfOpenRequest');
    }

    try {
      // Execute with timeout
      const result = await this.executeWithTimeout(fn);
      
      // Record success
      this.onSuccess(startTime);
      return result;
    } catch (error) {
      // Record failure
      this.onFailure(error as Error, startTime);
      throw error;
    }
  }

  /**
   * Execute function with timeout
   */
  private async executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        this.stats.timeoutRequests++;
        reject(new TimeoutError(`Request timed out after ${this.config.requestTimeoutMs}ms`));
      }, this.config.requestTimeoutMs);
    });

    return Promise.race([fn(), timeoutPromise]);
  }

  /**
   * Check if request should be allowed
   */
  private allowRequest(): boolean {
    if (this.state === 'CLOSED') {
      return true;
    }

    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now >= this.nextAttempt) {
        this.transitionTo('HALF_OPEN', 'Reset timeout elapsed');
        return true;
      }
      return false;
    }

    // HALF_OPEN: Allow limited requests
    return true;
  }

  /**
   * Handle successful execution
   */
  private onSuccess(startTime: number): void {
    const endTime = Date.now();
    this.stats.successfulRequests++;
    this.stats.consecutiveSuccesses++;
    this.consecutiveSuccesses++;
    
    this.updateStateTime(this.state, endTime - startTime);

    if (this.state === 'HALF_OPEN') {
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.transitionTo('CLOSED', 'Success threshold reached');
      }
    } else {
      // Reset failure count on success in CLOSED state
      if (this.failureCount > 0) {
        this.failureCount = Math.max(0, this.failureCount - 1);
      }
    }

    this.emit('success');
    
    if (this.config.debug) {
      console.log(`[CircuitBreaker:${this.name}] Success (consecutive: ${this.consecutiveSuccesses})`);
    }
  }

  /**
   * Handle failed execution
   */
  private onFailure(error: Error, startTime: number): void {
    const endTime = Date.now();
    this.stats.failedRequests++;
    this.stats.currentFailures++;
    this.lastFailureTime = Date.now();
    
    this.updateStateTime(this.state, endTime - startTime);

    // Check if error should be ignored
    if (this.shouldIgnoreError(error)) {
      if (this.config.debug) {
        console.log(`[CircuitBreaker:${this.name}] Ignored error: ${error.message}`);
      }
      return;
    }

    this.consecutiveSuccesses = 0;
    this.failureCount++;

    this.emit('failure', error, this.failureCount);

    if (this.config.debug) {
      console.log(`[CircuitBreaker:${this.name}] Failure (count: ${this.failureCount}/${this.config.failureThreshold})`);
    }

    // Check if we should open the circuit
    if (this.shouldOpenCircuit()) {
      this.transitionTo('OPEN', `Failure threshold reached (${this.failureCount}/${this.config.failureThreshold})`);
    }
  }

  /**
   * Check if error should be ignored
   */
  private shouldIgnoreError(error: Error): boolean {
    // Check by error code
    const errorCode = (error as any).code || (error as any).errorCode;
    if (errorCode && this.config.ignoredErrors.includes(errorCode)) {
      return true;
    }

    // Check by message
    for (const ignoredPattern of this.config.ignoredErrors) {
      if (error.message.includes(ignoredPattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if circuit should open
   */
  private shouldOpenCircuit(): boolean {
    return this.failureCount >= this.config.failureThreshold;
  }

  /**
   * Transition to new state
   */
  private transitionTo(newState: CircuitState, reason: string): void {
    const oldState = this.state;
    
    if (oldState === newState) {
      return;
    }

    this.state = newState;
    this.stats.lastStateChange = Date.now();

    // Reset counters based on new state
    if (newState === 'CLOSED') {
      this.failureCount = 0;
      this.consecutiveSuccesses = 0;
    } else if (newState === 'OPEN') {
      this.nextAttempt = Date.now() + this.config.resetTimeoutMs;
      this.consecutiveSuccesses = 0;
    } else if (newState === 'HALF_OPEN') {
      this.consecutiveSuccesses = 0;
    }

    this.emit('stateChange', oldState, newState, reason);

    if (this.config.debug) {
      console.log(`[CircuitBreaker:${this.name}] State change: ${oldState} -> ${newState} (${reason})`);
    }
  }

  /**
   * Update time spent in state
   */
  private updateStateTime(state: CircuitState, duration: number): void {
    this.stats.timeInState[state] = (this.stats.timeInState[state] || 0) + duration;
  }

  /**
   * Get next retry time
   */
  private getNextRetryTime(): number {
    if (this.state !== 'OPEN') {
      return 0;
    }
    return Math.max(0, this.nextAttempt - Date.now());
  }

  // ========================================================================
  // PUBLIC API
  // ========================================================================

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get statistics
   */
  getStats(): CircuitBreakerStats {
    return { ...this.stats };
  }

  /**
   * Get health status
   */
  getHealth(): {
    state: CircuitState;
    isHealthy: boolean;
    failureRate: number;
    nextRetryInMs?: number;
  } {
    const failureRate = this.stats.totalRequests > 0
      ? this.stats.failedRequests / this.stats.totalRequests
      : 0;

    return {
      state: this.state,
      isHealthy: this.state === 'CLOSED' || (this.state === 'HALF_OPEN' && failureRate < 0.5),
      failureRate,
      nextRetryInMs: this.state === 'OPEN' ? this.getNextRetryTime() : undefined,
    };
  }

  /**
   * Manually reset the circuit breaker
   */
  reset(): void {
    this.transitionTo('CLOSED', 'Manual reset');
  }

  /**
   * Force open the circuit breaker
   */
  forceOpen(): void {
    this.transitionTo('OPEN', 'Manual force open');
  }
}

// ============================================================================
// CIRCUIT BREAKER ERRORS
// ============================================================================

export class CircuitBreakerOpenError extends Error {
  code = 'CIRCUIT_BREAKER_OPEN';
  retryAfter: number;

  constructor(message: string, retryAfter: number) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
    this.retryAfter = retryAfter;
  }
}

export class TimeoutError extends Error {
  code = 'TIMEOUT';

  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

// ============================================================================
// CIRCUIT BREAKER REGISTRY
// Manage multiple circuit breakers
// ============================================================================

export class CircuitBreakerRegistry {
  private breakers: Map<string, CircuitBreaker> = new Map();
  private config: Partial<CircuitBreakerConfig>;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = config || {};
  }

  /**
   * Get or create a circuit breaker
   */
  get(name: string): CircuitBreaker {
    if (!this.breakers.has(name)) {
      const breaker = new CircuitBreaker(name, this.config);
      this.breakers.set(name, breaker);
    }
    return this.breakers.get(name)!;
  }

  /**
   * Get all circuit breakers
   */
  getAll(): Map<string, CircuitBreaker> {
    return new Map(this.breakers);
  }

  /**
   * Get health summary
   */
  getHealthSummary(): Record<string, ReturnType<CircuitBreaker['getHealth']>> {
    const summary: Record<string, ReturnType<CircuitBreaker['getHealth']>> = {};
    
    for (const [name, breaker] of this.breakers) {
      summary[name] = breaker.getHealth();
    }
    
    return summary;
  }

  /**
   * Remove a circuit breaker
   */
  remove(name: string): void {
    this.breakers.delete(name);
  }

  /**
   * Reset all circuit breakers
   */
  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createCircuitBreaker(
  name: string,
  config?: Partial<CircuitBreakerConfig>
): CircuitBreaker {
  return new CircuitBreaker(name, config);
}

export function createCircuitBreakerRegistry(
  config?: Partial<CircuitBreakerConfig>
): CircuitBreakerRegistry {
  return new CircuitBreakerRegistry(config);
}
