import { RealtimeService } from "@repo/shared";
import { createTypedSystemEvent, type CircuitBreakerEventPayload } from "@repo/mcp-protocol";

/**
 * CircuitBreaker - Phase 4: Harden Resilience
 * 
 * Implements the circuit breaker pattern to prevent cascade failures when
 * downstream services degrade. Uses a sliding window failure counter with
 * automatic state transitions.
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit tripped, requests fail fast
 * - HALF_OPEN: Testing recovery, limited requests allowed
 */

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerConfig {
  /** Number of failures before opening circuit */
  failureThreshold: number;
  /** Time in ms before attempting recovery (OPEN -> HALF_OPEN) */
  recoveryTimeoutMs: number;
  /** Number of successful requests in HALF_OPEN to close circuit */
  successThreshold: number;
  /** Time window in ms for counting failures (sliding window) */
  failureWindowMs: number;
  /** Service name for observability */
  serviceName: string;
  /** Server URL being protected */
  serverUrl: string;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  recoveryTimeoutMs: 60000, // 1 minute
  successThreshold: 2,
  failureWindowMs: 60000, // 1 minute
  serviceName: "unknown",
  serverUrl: "unknown",
};

export interface CircuitBreakerEvent {
  type: "state_change" | "failure" | "success";
  fromState: CircuitState;
  toState: CircuitState;
  failureCount: number;
  successCount: number;
  timestamp: string;
  reason?: string;
}

export class CircuitBreakerError extends Error {
  constructor(
    message: string,
    public readonly state: CircuitState,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "CircuitBreakerError";
  }
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private failureTimestamps: number[] = [];
  private lastFailureTime?: number;
  private lastStateChangeTime: number = Date.now();
  private stateChangeListeners: ((event: CircuitBreakerEvent) => void)[] = [];
  
  private config: CircuitBreakerConfig;
  private traceId?: string;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
  }

  /**
   * Set trace ID for observability correlation
   */
  setTraceId(traceId: string) {
    this.traceId = traceId;
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    // Check if we should transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN) {
      const timeSinceLastFailure = Date.now() - (this.lastFailureTime || 0);
      if (timeSinceLastFailure >= this.config.recoveryTimeoutMs) {
        this.transitionState(CircuitState.HALF_OPEN, "Recovery timeout elapsed");
      }
    }
    return this.state;
  }

  /**
   * Get detailed circuit status for observability
   */
  getStatus() {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      successCount: this.successCount,
      failureWindowMs: this.config.failureWindowMs,
      failureThreshold: this.config.failureThreshold,
      recoveryTimeoutMs: this.config.recoveryTimeoutMs,
      lastFailureTime: this.lastFailureTime,
      lastStateChangeTime: this.lastStateChangeTime,
      serviceName: this.config.serviceName,
      serverUrl: this.config.serverUrl,
    };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === CircuitState.OPEN) {
      const retryAfter = this.config.recoveryTimeoutMs - (Date.now() - (this.lastFailureTime || 0));
      
      await this.publishCircuitBreakerEvent("CircuitBreakerOpened", {
        reason: "Circuit is OPEN - failing fast",
        retryAfterMs: Math.max(0, retryAfter),
      });

      throw new CircuitBreakerError(
        `Circuit breaker OPEN for ${this.config.serviceName}. Retry after ${Math.max(0, Math.round(retryAfter / 1000))}s`,
        CircuitState.OPEN,
        Math.max(0, retryAfter)
      );
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  /**
   * Record a successful execution
   */
  private onSuccess(): void {
    const previousState = this.state;
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.transitionState(CircuitState.CLOSED, "Success threshold reached");
      }
    } else if (this.state === CircuitState.CLOSED) {
      // Reset failure count on success in CLOSED state
      this.failureCount = 0;
      this.failureTimestamps = [];
    }
  }

  /**
   * Record a failed execution
   */
  private onFailure(error: unknown): void {
    const now = Date.now();
    this.lastFailureTime = now;
    
    // Add to sliding window
    this.failureTimestamps.push(now);
    
    // Remove failures outside the window
    const windowStart = now - this.config.failureWindowMs;
    this.failureTimestamps = this.failureTimestamps.filter(
      (ts) => ts > windowStart
    );
    
    this.failureCount = this.failureTimestamps.length;

    // Check if we should open the circuit
    if (this.state === CircuitState.CLOSED && 
        this.failureCount >= this.config.failureThreshold) {
      this.transitionState(
        CircuitState.OPEN,
        `Failure threshold reached (${this.failureCount}/${this.config.failureThreshold})`
      );
    }
  }

  /**
   * Manually reset the circuit breaker
   */
  reset(): void {
    this.transitionState(CircuitState.CLOSED, "Manual reset");
    this.failureCount = 0;
    this.successCount = 0;
    this.failureTimestamps = [];
    this.lastFailureTime = undefined;
  }

  /**
   * Force circuit to open (for testing or manual intervention)
   */
  forceOpen(reason?: string): void {
    this.transitionState(CircuitState.OPEN, reason || "Forced open");
  }

  /**
   * Force circuit to close (for testing or manual intervention)
   */
  forceClose(): void {
    this.reset();
  }

  /**
   * Subscribe to state change events
   */
  onStateChange(listener: (event: CircuitBreakerEvent) => void): () => void {
    this.stateChangeListeners.push(listener);
    return () => {
      const index = this.stateChangeListeners.indexOf(listener);
      if (index > -1) {
        this.stateChangeListeners.splice(index, 1);
      }
    };
  }

  /**
   * Transition to a new state and notify listeners
   */
  private transitionState(newState: CircuitState, reason?: string): void {
    if (this.state === newState) return;

    const previousState = this.state;
    this.state = newState;
    this.lastStateChangeTime = Date.now();
    
    if (newState === CircuitState.HALF_OPEN) {
      this.successCount = 0;
    } else if (newState === CircuitState.CLOSED) {
      this.successCount = 0;
      this.failureCount = 0;
      this.failureTimestamps = [];
    }

    const event: CircuitBreakerEvent = {
      type: "state_change",
      fromState: previousState,
      toState: newState,
      failureCount: this.failureCount,
      successCount: this.successCount,
      timestamp: new Date().toISOString(),
      reason,
    };

    // Notify listeners
    for (const listener of this.stateChangeListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[CircuitBreaker] State change listener error:", err);
      }
    }

    // Publish to Nervous System mesh
    this.publishCircuitBreakerEvent(
      newState === CircuitState.OPEN ? "CircuitBreakerOpened" : "CircuitBreakerClosed",
      { reason }
    ).catch(err => console.error("[CircuitBreaker] Failed to publish event:", err));

    console.log(
      `[CircuitBreaker:${this.config.serviceName}] ${previousState} -> ${newState}${reason ? `: ${reason}` : ""}`
    );
  }

  /**
   * Publish circuit breaker events to the Nervous System mesh
   */
  private async publishCircuitBreakerEvent(
    eventType: "CircuitBreakerOpened" | "CircuitBreakerClosed",
    extra: { reason?: string; retryAfterMs?: number }
  ): Promise<void> {
    try {
      const payload: CircuitBreakerEventPayload = {
        serviceName: this.config.serviceName,
        serverUrl: this.config.serverUrl,
        state: this.state,
        failureCount: this.failureCount,
        lastFailureTime: this.lastFailureTime ? new Date(this.lastFailureTime).toISOString() : undefined,
        ...extra,
      };

      // Phase 2: Use structured SystemEvent schema
      const event = createTypedSystemEvent(
        eventType,
        payload,
        "intention-engine",
        { traceId: this.traceId }
      );

      await RealtimeService.publishNervousSystemEvent(
        event.type,
        event.payload,
        event.traceId
      );
    } catch (error) {
      // Don't throw - circuit breaker events are observability, not critical path
      console.warn("[CircuitBreaker] Failed to publish event to mesh:", error);
    }
  }
}

/**
 * CircuitBreakerRegistry - Manages circuit breakers for multiple services
 */
export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private defaultConfig: Partial<CircuitBreakerConfig>;

  constructor(defaultConfig: Partial<CircuitBreakerConfig> = {}) {
    this.defaultConfig = defaultConfig;
  }

  /**
   * Get or create a circuit breaker for a service
   */
  get(serviceName: string, serverUrl: string): CircuitBreaker {
    const key = `${serviceName}:${serverUrl}`;
    
    if (!this.breakers.has(key)) {
      const breaker = new CircuitBreaker({
        ...this.defaultConfig,
        serviceName,
        serverUrl,
      });
      this.breakers.set(key, breaker);
    }
    
    return this.breakers.get(key)!;
  }

  /**
   * Get all circuit breakers
   */
  getAll(): Map<string, CircuitBreaker> {
    return new Map(this.breakers);
  }

  /**
   * Get status of all circuit breakers
   */
  getStatusReport() {
    const report: Record<string, ReturnType<CircuitBreaker["getStatus"]>> = {};
    
    for (const [key, breaker] of this.breakers.entries()) {
      report[key] = breaker.getStatus();
    }
    
    return report;
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

// Default registry instance
export const defaultCircuitBreakerRegistry = new CircuitBreakerRegistry();
