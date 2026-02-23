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
import { Redis } from '@upstash/redis';

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

// ============================================================================
// COST-BASED CIRCUIT BREAKER
// Prevents "Budget Bleed" from runaway LLM calls or logic loops
// ============================================================================

export interface CostCircuitBreakerConfig {
  /** Maximum cost per execution in USD (default: $1.00) */
  maxCostPerExecution: number;
  /** Maximum cost per user per day in USD (default: $5.00) */
  maxCostPerUserPerDay: number;
  /** Cost threshold for warning (default: 80% of max) */
  warningThreshold: number;
  /** Blacklist duration in hours when daily limit exceeded (default: 24h) */
  blacklistDurationHours: number;
  /** Enable debug logging */
  debug: boolean;
}

const DEFAULT_COST_CONFIG: CostCircuitBreakerConfig = {
  maxCostPerExecution: 1.00, // $1.00 per execution
  maxCostPerUserPerDay: 5.00, // $5.00 per user per day
  warningThreshold: 0.80, // 80% of limit
  blacklistDurationHours: 24,
  debug: false,
};

export interface CostTracking {
  executionId: string;
  userId: string;
  currentCost: number;
  dailyCost: number;
  lastUpdated: number;
}

export class CostCircuitBreaker {
  private config: CostCircuitBreakerConfig;
  private redis: Redis;
  private executionCosts: Map<string, number> = new Map();

  constructor(redis: Redis, config: Partial<CostCircuitBreakerConfig> = {}) {
    this.redis = redis;
    this.config = { ...DEFAULT_COST_CONFIG, ...config };
  }

  /**
   * Build Redis key for user daily cost
   */
  private buildUserDailyCostKey(userId: string): string {
    const today = new Date().toISOString().split('T')[0];
    return `cost:daily:${userId}:${today}`;
  }

  /**
   * Build Redis key for user blacklist status
   */
  private buildUserBlacklistKey(userId: string): string {
    return `cost:blacklist:${userId}`;
  }

  /**
   * Build Redis key for execution cost
   */
  private buildExecutionCostKey(executionId: string): string {
    return `cost:execution:${executionId}`;
  }

  /**
   * Check if user is blacklisted
   */
  async isUserBlacklisted(userId: string): Promise<boolean> {
    const blacklistKey = this.buildUserBlacklistKey(userId);
    const blacklisted = await this.redis.get<string>(blacklistKey);
    return blacklisted === 'true';
  }

  /**
   * Get current cost for an execution
   */
  async getExecutionCost(executionId: string): Promise<number> {
    const key = this.buildExecutionCostKey(executionId);
    const cost = await this.redis.get<number>(key);
    return cost || 0;
  }

  /**
   * Get daily cost for a user
   */
  async getUserDailyCost(userId: string): Promise<number> {
    const key = this.buildUserDailyCostKey(userId);
    const cost = await this.redis.get<number>(key);
    return cost || 0;
  }

  /**
   * Assert that adding a cost won't exceed budget
   * 
   * @param executionId - Execution identifier
   * @param userId - User identifier
   * @param additionalCost - Cost to add in USD
   * @throws Error if budget would be exceeded
   */
  async assertBudgetSafety(
    executionId: string,
    userId: string,
    additionalCost: number
  ): Promise<{
    allowed: boolean;
    reason?: string;
    currentExecutionCost: number;
    currentDailyCost: number;
    projectedDailyCost: number;
  }> {
    const [currentExecutionCost, currentDailyCost, isBlacklisted] = await Promise.all([
      this.getExecutionCost(executionId),
      this.getUserDailyCost(userId),
      this.isUserBlacklisted(userId),
    ]);

    // Check if user is blacklisted
    if (isBlacklisted) {
      return {
        allowed: false,
        reason: `User ${userId} is blacklisted due to exceeding daily budget`,
        currentExecutionCost,
        currentDailyCost,
        projectedDailyCost: currentDailyCost + additionalCost,
      };
    }

    const projectedExecutionCost = currentExecutionCost + additionalCost;
    const projectedDailyCost = currentDailyCost + additionalCost;

    // Check execution budget
    if (projectedExecutionCost > this.config.maxCostPerExecution) {
      return {
        allowed: false,
        reason: `Execution would exceed budget ($${projectedExecutionCost.toFixed(4)} > $${this.config.maxCostPerExecution.toFixed(2)})`,
        currentExecutionCost,
        currentDailyCost,
        projectedDailyCost,
      };
    }

    // Check daily budget
    if (projectedDailyCost > this.config.maxCostPerUserPerDay) {
      return {
        allowed: false,
        reason: `User would exceed daily budget ($${projectedDailyCost.toFixed(4)} > $${this.config.maxCostPerUserPerDay.toFixed(2)})`,
        currentExecutionCost,
        currentDailyCost,
        projectedDailyCost,
      };
    }

    // Check warning threshold
    if (projectedDailyCost > this.config.maxCostPerUserPerDay * this.config.warningThreshold) {
      console.warn(
        `[CostCircuitBreaker] User ${userId} approaching daily budget: ` +
        `$${projectedDailyCost.toFixed(4)} / $${this.config.maxCostPerUserPerDay.toFixed(2)} ` +
        `(${((projectedDailyCost / this.config.maxCostPerUserPerDay) * 100).toFixed(1)}%)`
      );
    }

    return {
      allowed: true,
      currentExecutionCost,
      currentDailyCost,
      projectedDailyCost,
    };
  }

  /**
   * Track cost for an execution
   */
  async trackCost(
    executionId: string,
    userId: string,
    cost: number
  ): Promise<void> {
    const executionKey = this.buildExecutionCostKey(executionId);
    const userDailyKey = this.buildUserDailyCostKey(userId);
    const now = Date.now();

    // Update execution cost
    await this.redis.setex(executionKey, 86400, cost);

    // Update daily cost (increment)
    const currentDailyCost = await this.getUserDailyCost(userId);
    const newDailyCost = currentDailyCost + cost;
    await this.redis.setex(userDailyKey, 86400, newDailyCost);

    // Check if daily budget exceeded
    if (newDailyCost > this.config.maxCostPerUserPerDay) {
      await this.blacklistUser(userId);
    }

    if (this.config.debug) {
      console.log(
        `[CostCircuitBreaker] Tracked $${cost.toFixed(4)} for execution ${executionId}, ` +
        `user daily: $${newDailyCost.toFixed(4)}`
      );
    }
  }

  /**
   * Blacklist a user for exceeding budget
   */
  private async blacklistUser(userId: string): Promise<void> {
    const blacklistKey = this.buildUserBlacklistKey(userId);
    const ttlSeconds = this.config.blacklistDurationHours * 60 * 60;

    await this.redis.setex(blacklistKey, ttlSeconds, 'true');

    console.warn(
      `[CostCircuitBreaker] User ${userId} blacklisted for ${this.config.blacklistDurationHours}h ` +
      `due to exceeding daily budget`
    );

    // Emit alert to Ably for monitoring
    try {
      const { RealtimeService } = require('../realtime');
      await RealtimeService.publish('system:alerts', 'cost_budget_exceeded', {
        userId,
        blacklistDurationHours: this.config.blacklistDurationHours,
        maxDailyCost: this.config.maxCostPerUserPerDay,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('[CostCircuitBreaker] Failed to emit alert:', error);
    }
  }

  /**
   * Reset execution cost (call when execution completes)
   */
  async resetExecution(executionId: string): Promise<void> {
    const key = this.buildExecutionCostKey(executionId);
    await this.redis.del(key);
  }

  /**
   * Get cost statistics for a user
   */
  async getUserStats(userId: string): Promise<{
    dailyCost: number;
    isBlacklisted: boolean;
    blacklistExpiresIn?: number;
    budgetRemaining: number;
    budgetUsedPercent: number;
  }> {
    const [dailyCost, isBlacklisted] = await Promise.all([
      this.getUserDailyCost(userId),
      this.isUserBlacklisted(userId),
    ]);

    const blacklistKey = this.buildUserBlacklistKey(userId);
    const ttl = await this.redis.ttl(blacklistKey);

    return {
      dailyCost,
      isBlacklisted,
      blacklistExpiresIn: ttl > 0 ? ttl : undefined,
      budgetRemaining: Math.max(0, this.config.maxCostPerUserPerDay - dailyCost),
      budgetUsedPercent: (dailyCost / this.config.maxCostPerUserPerDay) * 100,
    };
  }

  /**
   * Manual blacklist (for admin intervention)
   */
  async manualBlacklist(userId: string, durationHours: number = 24): Promise<void> {
    const blacklistKey = this.buildUserBlacklistKey(userId);
    const ttlSeconds = durationHours * 60 * 60;

    await this.redis.setex(blacklistKey, ttlSeconds, 'true');

    console.warn(
      `[CostCircuitBreaker] User ${userId} manually blacklisted for ${durationHours}h`
    );
  }

  /**
   * Remove blacklist (for admin intervention)
   */
  async removeBlacklist(userId: string): Promise<void> {
    const blacklistKey = this.buildUserBlacklistKey(userId);
    await this.redis.del(blacklistKey);

    console.log(`[CostCircuitBreaker] Removed blacklist for user ${userId}`);
  }
}

// ============================================================================
// COST-BASED CIRCUIT BREAKER FACTORY
// ============================================================================

export function createCostCircuitBreaker(
  redis: Redis,
  config?: Partial<CostCircuitBreakerConfig>
): CostCircuitBreaker {
  return new CostCircuitBreaker(redis, config);
}
