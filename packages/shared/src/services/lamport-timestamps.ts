/**
 * Lamport Timestamps for Distributed Event Ordering
 *
 * Implements logical clocks to establish causal ordering of events
 * across distributed services, solving the clock skew problem where
 * physical timestamps may be inconsistent across servers.
 *
 * Key Concepts:
 * - Each service maintains a logical counter
 * - Counter increments on each local event
 * - Counter increments when receiving messages
 * - Events are ordered by (counter, serviceId) tuples
 *
 * Use Cases:
 * - Distributed tracing across TableStack, IntentionEngine, OpenDelivery
 * - Event sourcing with correct causal ordering
 * - Debugging waterfall traces with impossible physical timestamps
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { Redis } from "@upstash/redis";
import { z } from "zod";

// ============================================================================
// SCHEMAS
// ============================================================================

/**
 * Lamport timestamp schema
 */
export const LamportTimestampSchema = z.object({
  /** Logical counter value */
  counter: z.number().int().positive(),
  /** Service identifier (e.g., "intention-engine", "table-stack") */
  serviceId: z.string(),
  /** Physical timestamp for reference */
  physicalTime: z.number().positive(),
  /** Optional parent event ID for causal chain */
  parentId: z.string().uuid().optional(),
  /** Optional execution context */
  executionId: z.string().uuid().optional(),
  /** Optional trace ID for distributed tracing */
  traceId: z.string().optional(),
});

export type LamportTimestamp = z.infer<typeof LamportTimestampSchema>;

/**
 * Event with Lamport timestamp
 */
export const TimestampedEventSchema = z.object({
  /** Event type/name */
  eventType: z.string(),
  /** Event payload */
  payload: z.record(z.unknown()),
  /** Lamport timestamp */
  timestamp: LamportTimestampSchema,
  /** Optional correlation ID for grouping related events */
  correlationId: z.string().uuid().optional(),
});

export type TimestampedEvent<T = any> = z.infer<typeof TimestampedEventSchema> & {
  payload: T;
};

// ============================================================================
// LAMPORT CLOCK SERVICE
// ============================================================================

export class LamportClock {
  private counter: number = 0;
  private serviceId: string;
  private redis?: Redis;
  private redisKey?: string;

  constructor(serviceId: string, redis?: Redis, redisKey?: string) {
    this.serviceId = serviceId;
    this.redis = redis;
    this.redisKey = redisKey || `lamport:${serviceId}`;
  }

  /**
   * Initialize clock from Redis (for distributed consistency)
   */
  async initialize(): Promise<void> {
    if (!this.redis || !this.redisKey) {
      return;
    }

    try {
      const stored = await this.redis.get<number>(this.redisKey);
      if (stored) {
        this.counter = stored;
        console.log(`[LamportClock] Initialized counter for ${this.serviceId}: ${this.counter}`);
      }
    } catch (error) {
      console.error(`[LamportClock] Failed to initialize from Redis:`, error);
    }
  }

  /**
   * Get current counter value
   */
  getCounter(): number {
    return this.counter;
  }

  /**
   * Increment counter and return new value
   */
  tick(): number {
    this.counter++;
    return this.counter;
  }

  /**
   * Update counter when receiving a message
   * Sets counter to max(local, received) + 1
   */
  receive(receivedTimestamp: number): number {
    this.counter = Math.max(this.counter, receivedTimestamp) + 1;
    return this.counter;
  }

  /**
   * Create a new timestamp for a local event
   */
  timestamp(parentId?: string, executionId?: string, traceId?: string): LamportTimestamp {
    this.tick();
    
    // Persist to Redis for durability
    this.persist();

    return {
      counter: this.counter,
      serviceId: this.serviceId,
      physicalTime: Date.now(),
      parentId,
      executionId,
      traceId,
    };
  }

  /**
   * Create a timestamp when receiving an event
   */
  receiveTimestamp(parentTimestamp: LamportTimestamp): LamportTimestamp {
    this.receive(parentTimestamp.counter);
    
    this.persist();

    return {
      counter: this.counter,
      serviceId: this.serviceId,
      physicalTime: Date.now(),
      parentId: parentTimestamp.parentId,
      executionId: parentTimestamp.executionId,
      traceId: parentTimestamp.traceId,
    };
  }

  /**
   * Persist counter to Redis
   */
  private async persist(): Promise<void> {
    if (!this.redis || !this.redisKey) {
      return;
    }

    try {
      await this.redis.setex(this.redisKey, 86400, this.counter);
    } catch (error) {
      console.error(`[LamportClock] Failed to persist counter:`, error);
    }
  }

  /**
   * Compare two timestamps
   * Returns:
   * - negative if a < b (a happened before b)
   * - positive if a > b (a happened after b)
   * - 0 if concurrent (cannot determine order)
   */
  static compare(a: LamportTimestamp, b: LamportTimestamp): number {
    // First compare by counter
    if (a.counter !== b.counter) {
      return a.counter - b.counter;
    }

    // If counters equal, use serviceId as tiebreaker
    return a.serviceId.localeCompare(b.serviceId);
  }

  /**
   * Check if event a happened before event b
   */
  static happenedBefore(a: LamportTimestamp, b: LamportTimestamp): boolean {
    return LamportClock.compare(a, b) < 0;
  }

  /**
   * Check if two events are concurrent (cannot determine order)
   */
  static areConcurrent(a: LamportTimestamp, b: LamportTimestamp): boolean {
    // Events are concurrent if neither happened before the other
    // In practice, this means they have the same counter but different serviceIds
    return a.counter === b.counter && a.serviceId !== b.serviceId;
  }

  /**
   * Sort events by Lamport timestamp
   */
  static sortEvents<T extends { timestamp: LamportTimestamp }>(events: T[]): T[] {
    return events.sort((a, b) => LamportClock.compare(a.timestamp, b.timestamp));
  }
}

// ============================================================================
// EVENT BUS WITH LAMPORT TIMESTAMPS
// ============================================================================

export interface EventMetadata {
  eventType: string;
  payload: Record<string, unknown>;
  lamportTimestamp: LamportTimestamp;
  correlationId?: string;
  physicalTime?: number;
}

export class TimestampedEventBus {
  private clock: LamportClock;
  private eventHistory: TimestampedEvent[] = [];
  private maxHistorySize: number = 1000;

  constructor(clock: LamportClock) {
    this.clock = clock;
  }

  /**
   * Publish an event with Lamport timestamp
   */
  publish<T = any>(
    eventType: string,
    payload: T,
    options?: {
      parentId?: string;
      executionId?: string;
      traceId?: string;
      correlationId?: string;
    }
  ): TimestampedEvent<T> {
    const timestamp = this.clock.timestamp(
      options?.parentId,
      options?.executionId,
      options?.traceId
    );

    const event: TimestampedEvent<T> = {
      eventType,
      payload,
      timestamp,
      correlationId: options?.correlationId,
    };

    // Add to history
    this.eventHistory.push(event);

    // Trim history if needed
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory = this.eventHistory.slice(-this.maxHistorySize);
    }

    return event;
  }

  /**
   * Receive an event from another service
   */
  receive<T = any>(event: TimestampedEvent<T>): void {
    // Update our clock based on received timestamp
    this.clock.receive(event.timestamp.counter);

    // Add to history
    this.eventHistory.push(event);

    // Trim history if needed
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory = this.eventHistory.slice(-this.maxHistorySize);
    }
  }

  /**
   * Get events ordered by Lamport timestamp
   */
  getOrderedEvents(startTime?: LamportTimestamp, endTime?: LamportTimestamp): TimestampedEvent[] {
    let events = [...this.eventHistory];

    // Filter by time range if specified
    if (startTime) {
      events = events.filter(e => LamportClock.compare(e.timestamp, startTime) >= 0);
    }
    if (endTime) {
      events = events.filter(e => LamportClock.compare(e.timestamp, endTime) <= 0);
    }

    // Sort by Lamport timestamp
    return LamportClock.sortEvents(events);
  }

  /**
   * Get events by correlation ID
   */
  getEventsByCorrelationId(correlationId: string): TimestampedEvent[] {
    return this.eventHistory
      .filter(e => e.correlationId === correlationId)
      .sort((a, b) => LamportClock.compare(a.timestamp, b.timestamp));
  }

  /**
   * Get events by execution ID
   */
  getEventsByExecutionId(executionId: string): TimestampedEvent[] {
    return this.eventHistory
      .filter(e => e.timestamp.executionId === executionId)
      .sort((a, b) => LamportClock.compare(a.timestamp, b.timestamp));
  }

  /**
   * Clear event history
   */
  clear(): void {
    this.eventHistory = [];
  }
}

// ============================================================================
// DISTRIBUTED LAMPORT CLOCK MANAGER
// Manages Lamport clocks across multiple services
// ============================================================================

export interface ServiceClockState {
  serviceId: string;
  counter: number;
  lastUpdated: number;
}

export class DistributedLamportManager {
  private redis: Redis;
  private clocks: Map<string, LamportClock> = new Map();
  private localClock?: LamportClock;

  constructor(redis: Redis, localServiceId: string) {
    this.redis = redis;
    this.localClock = new LamportClock(localServiceId, redis, `lamport:${localServiceId}`);
  }

  /**
   * Initialize the local clock
   */
  async initialize(): Promise<void> {
    await this.localClock?.initialize();
  }

  /**
   * Get the local clock
   */
  getLocalClock(): LamportClock | undefined {
    return this.localClock;
  }

  /**
   * Get or create a clock for a service
   */
  getClock(serviceId: string): LamportClock {
    if (!this.clocks.has(serviceId)) {
      const clock = new LamportClock(serviceId, this.redis, `lamport:${serviceId}`);
      this.clocks.set(serviceId, clock);
    }
    return this.clocks.get(serviceId)!;
  }

  /**
   * Get clock states for all services
   */
  async getClockStates(): Promise<ServiceClockState[]> {
    const states: ServiceClockState[] = [];

    for (const [serviceId, clock] of this.clocks) {
      const key = `lamport:${serviceId}`;
      const counter = await this.redis.get<number>(key);
      
      states.push({
        serviceId,
        counter: counter || clock.getCounter(),
        lastUpdated: Date.now(),
      });
    }

    return states;
  }

  /**
   * Synchronize clocks (for debugging/observability)
   */
  async synchronizeClocks(): Promise<void> {
    // Initialize all clocks from Redis
    for (const clock of this.clocks.values()) {
      await clock.initialize();
    }
  }

  /**
   * Get event ordering for debugging
   */
  async getEventOrdering(
    events: Array<{ eventType: string; timestamp: LamportTimestamp }>
  ): Promise<Array<{ eventType: string; timestamp: LamportTimestamp; order: number }>> {
    const sorted = LamportClock.sortEvents(events);
    return sorted.map((event, index) => ({
      ...event,
      order: index + 1,
    }));
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

export function createLamportClock(
  serviceId: string,
  redis?: Redis
): LamportClock {
  const clock = new LamportClock(serviceId, redis, `lamport:${serviceId}`);
  clock.initialize();
  return clock;
}

export function createTimestampedEventBus(
  serviceId: string,
  redis?: Redis
): { clock: LamportClock; eventBus: TimestampedEventBus } {
  const clock = createLamportClock(serviceId, redis);
  const eventBus = new TimestampedEventBus(clock);
  return { clock, eventBus };
}

export function createDistributedLamportManager(
  redis: Redis,
  localServiceId: string
): DistributedLamportManager {
  const manager = new DistributedLamportManager(redis, localServiceId);
  manager.initialize();
  return manager;
}
