/**
 * Sequence ID Service - Causal Ordering Guarantee
 *
 * Problem Solved: Event Ordering in Distributed Systems
 * - Ably (and most pub/sub systems) do not guarantee causal ordering
 * - SAGA_STEP_COMPLETED (Step 2) may arrive before SAGA_STEP_COMPLETED (Step 1)
 * - This causes UI flickering and incorrect state reconstruction
 *
 * Solution: Lamport-style sequence IDs with receiver-side buffering
 * - Each event carries a monotonically increasing sequence_id
 * - Receiver buffers out-of-order events and releases in order
 * - Prevents "time travel" bugs in state reconstruction
 *
 * Usage:
 * ```typescript
 * // Publisher side
 * const sequenceId = SequenceIdService.next('workflow:123');
 * await RealtimeService.publishNervousSystemEvent('SAGA_STEP_COMPLETED', {
 *   sequenceId,
 *   stepNumber: 2,
 *   ...
 * });
 *
 * // Subscriber side
 * const buffer = createOrderedEventBuffer('workflow:123');
 * buffer.push(event); // Automatically buffers and releases in order
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { Redis } from "@upstash/redis";
import { getRedisClient, ServiceNamespace } from "../redis";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface SequenceIdEvent {
  /** Unique sequence ID for causal ordering */
  sequenceId: number;
  /** Logical timestamp (Lamport clock) */
  lamportTimestamp: number;
  /** Event payload */
  data: Record<string, unknown>;
  /** Event type/name */
  eventType: string;
  /** Correlation ID for tracing */
  correlationId?: string;
  /** Trace ID for distributed tracing */
  traceId?: string;
  /** When event was created */
  createdAt: string;
}

export interface OrderedEventBufferConfig {
  /** How long to wait for missing events before releasing buffered events */
  maxWaitMs: number;
  /** Maximum buffer size before forcing release */
  maxBufferSize: number;
  /** Enable debug logging */
  debug: boolean;
}

const DEFAULT_BUFFER_CONFIG: OrderedEventBufferConfig = {
  maxWaitMs: 5000, // Wait up to 5 seconds for missing events
  maxBufferSize: 100, // Force release after 100 events
  debug: false,
};

/**
 * SEQUENCE ID SERVICE
 * Generates monotonically increasing sequence IDs per workflow/execution
 */

export class SequenceIdService {
  private static redis: Redis;

  static initialize(redis?: Redis): void {
    this.redis = redis || getRedisClient(ServiceNamespace.SHARED);
  }

  private static getRedis(): Redis {
    if (!this.redis) {
      this.initialize();
    }
    return this.redis;
  }

  /**
   * Build Redis key for sequence counter
   */
  private static buildKey(scope: string): string {
    return `seq:${scope}`;
  }

  /**
   * Generate next sequence ID for a scope (atomic increment)
   *
   * @param scope - Scope for sequence (e.g., workflow ID, execution ID)
   * @returns Monotonically increasing sequence ID
   */
  static async next(scope: string): Promise<number> {
    const key = this.buildKey(scope);
    const count = await this.getRedis().incr(key);

    // Set expiry to prevent memory leak (7 days)
    await this.getRedis().expire(key, 86400 * 7);

    return count as number;
  }

  /**
   * Get current sequence ID without incrementing
   */
  static async current(scope: string): Promise<number> {
    const key = this.buildKey(scope);
    const value = await this.getRedis().get<number>(key);
    return value || 0;
  }

  /**
   * Reset sequence ID for a scope
   */
  static async reset(scope: string): Promise<void> {
    const key = this.buildKey(scope);
    await this.getRedis().del(key);
  }

  /**
   * Generate sequence ID for event (convenience method)
   *
   * @param scope - Scope for sequence
   * @param eventType - Type of event
   * @param data - Event payload
   * @returns Complete SequenceIdEvent with sequence ID
   */
  static async generateEvent(
    scope: string,
    eventType: string,
    data: Record<string, unknown>,
    options?: {
      correlationId?: string;
      traceId?: string;
    }
  ): Promise<SequenceIdEvent> {
    const sequenceId = await this.next(scope);
    const lamportTimestamp = Date.now();

    return {
      sequenceId,
      lamportTimestamp,
      data,
      eventType,
      correlationId: options?.correlationId,
      traceId: options?.traceId,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Validate event ordering
   *
   * @param events - Array of events to validate
   * @returns True if events are in order, false otherwise
   */
  static validateOrder(events: SequenceIdEvent[]): boolean {
    for (let i = 1; i < events.length; i++) {
      if (events[i].sequenceId <= events[i - 1].sequenceId) {
        return false;
      }
    }
    return true;
  }
}

/**
 * ORDERED EVENT BUFFER
 * Buffers out-of-order events and releases them in sequence order
 */

export class OrderedEventBuffer {
  private scope: string;
  private config: OrderedEventBufferConfig;
  private expectedSequenceId: number = 1;
  private buffer: Map<number, SequenceIdEvent> = new Map();
  private waitTimer: NodeJS.Timeout | null = null;
  private onEventReady?: (event: SequenceIdEvent) => void;
  private onBatchReady?: (events: SequenceIdEvent[]) => void;

  constructor(
    scope: string,
    config: Partial<OrderedEventBufferConfig> = {},
    callbacks?: {
      onEventReady?: (event: SequenceIdEvent) => void;
      onBatchReady?: (events: SequenceIdEvent[]) => void;
    }
  ) {
    this.scope = scope;
    this.config = { ...DEFAULT_BUFFER_CONFIG, ...config };
    this.onEventReady = callbacks?.onEventReady;
    this.onBatchReady = callbacks?.onBatchReady;
  }

  /**
   * Push an event to the buffer
   * - If event is next in sequence, release immediately
   * - If event is out of order, buffer it
   * - Release any consecutive buffered events
   */
  async push(event: SequenceIdEvent): Promise<void> {
    const { sequenceId } = event;

    if (this.config.debug) {
      console.log(
        `[OrderedEventBuffer] Received event seq=${sequenceId} ` +
        `(expected=${this.expectedSequenceId}, buffer=${this.buffer.size})`
      );
    }

    // Event is next in sequence - release immediately
    if (sequenceId === this.expectedSequenceId) {
      await this.releaseEvent(event);
      this.expectedSequenceId++;
      
      // Release any consecutive buffered events
      await this.releaseBufferedEvents();
    } 
    // Event is in the future - buffer it
    else if (sequenceId > this.expectedSequenceId) {
      this.buffer.set(sequenceId, event);
      
      // Start wait timer if not already running
      if (!this.waitTimer && this.buffer.size > 0) {
        this.startWaitTimer();
      }
      
      // Force release if buffer is full
      if (this.buffer.size >= this.config.maxBufferSize) {
        await this.forceRelease();
      }
    }
    // Event is duplicate or old - ignore
    else {
      if (this.config.debug) {
        console.log(
          `[OrderedEventBuffer] Ignoring old event seq=${sequenceId} ` +
          `(expected=${this.expectedSequenceId})`
        );
      }
    }
  }

  /**
   * Release a single event
   */
  private async releaseEvent(event: SequenceIdEvent): Promise<void> {
    if (this.onEventReady) {
      this.onEventReady(event);
    }
  }

  /**
   * Release consecutive buffered events
   */
  private async releaseBufferedEvents(): Promise<void> {
    let released = 0;
    
    while (this.buffer.has(this.expectedSequenceId)) {
      const event = this.buffer.get(this.expectedSequenceId)!;
      this.buffer.delete(this.expectedSequenceId);
      await this.releaseEvent(event);
      this.expectedSequenceId++;
      released++;
    }

    if (released > 0 && this.config.debug) {
      console.log(
        `[OrderedEventBuffer] Released ${released} buffered events ` +
        `(new expected=${this.expectedSequenceId}, remaining=${this.buffer.size})`
      );
    }

    // Clear timer if buffer is empty
    if (this.buffer.size === 0 && this.waitTimer) {
      this.clearWaitTimer();
    }
  }

  /**
   * Start wait timer for missing events
   */
  private startWaitTimer(): void {
    if (this.waitTimer) return;

    this.waitTimer = setTimeout(async () => {
      await this.forceRelease();
    }, this.config.maxWaitMs);
  }

  /**
   * Clear wait timer
   */
  private clearWaitTimer(): void {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
  }

  /**
   * Force release all buffered events (even if gaps exist)
   */
  private async forceRelease(): Promise<void> {
    const events = Array.from(this.buffer.values()).sort(
      (a, b) => a.sequenceId - b.sequenceId
    );

    if (events.length > 0 && this.config.debug) {
      console.log(
        `[OrderedEventBuffer] Force releasing ${events.length} events ` +
        `(gaps may exist, new expected=${this.expectedSequenceId + events.length})`
      );
    }

    for (const event of events) {
      await this.releaseEvent(event);
    }

    if (events.length > 0) {
      this.expectedSequenceId = events[events.length - 1].sequenceId + 1;
    }

    this.buffer.clear();
    this.clearWaitTimer();
  }

  /**
   * Get buffer statistics
   */
  getStats(): {
    expectedSequenceId: number;
    bufferedCount: number;
    hasGaps: boolean;
  } {
    const sequenceIds = Array.from(this.buffer.keys()).sort((a, b) => a - b);
    const hasGaps = sequenceIds.some((id, i) => {
      if (i === 0) return id !== this.expectedSequenceId;
      return id !== sequenceIds[i - 1] + 1;
    });

    return {
      expectedSequenceId: this.expectedSequenceId,
      bufferedCount: this.buffer.size,
      hasGaps,
    };
  }

  /**
   * Clear the buffer
   */
  clear(): void {
    this.buffer.clear();
    this.clearWaitTimer();
    this.expectedSequenceId = 1;
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create an ordered event buffer for a scope
 */
export function createOrderedEventBuffer(
  scope: string,
  config?: Partial<OrderedEventBufferConfig>,
  callbacks?: {
    onEventReady?: (event: SequenceIdEvent) => void;
    onBatchReady?: (events: SequenceIdEvent[]) => void;
  }
): OrderedEventBuffer {
  return new OrderedEventBuffer(scope, config, callbacks);
}

/**
 * Wrap event publishing with automatic sequence ID generation
 */
export function createSequencedPublisher(scope: string) {
  return {
    async publish(
      eventType: string,
      data: Record<string, unknown>,
      options?: {
        correlationId?: string;
        traceId?: string;
      }
    ): Promise<SequenceIdEvent> {
      return SequenceIdService.generateEvent(scope, eventType, data, options);
    },
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export { SequenceIdService };
export type { SequenceIdEvent, OrderedEventBufferConfig };
