/**
 * Transactional Outbox Service
 *
 * Implements the Transactional Outbox Pattern to ensure data consistency
 * between Postgres (business data) and Redis (saga state cache).
 *
 * Problem Solved: Split-Brain State Risk
 * - Previously: Redis write and Postgres write were separate operations
 * - Risk: If Redis flushes or latency spikes occur, saga may re-execute completed steps
 * - Solution: Write "State Change Event" to Postgres outbox table within same transaction as business data
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { db, outbox, outboxStatusEnum } from '@repo/database';
import { sql } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import { getRedisClient, ServiceNamespace } from './redis';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type OutboxEventType =
  | 'SAGA_STEP_COMPLETED'
  | 'SAGA_STEP_FAILED'
  | 'SAGA_COMPENSATION_TRIGGERED'
  | 'SAGA_COMPENSATION_COMPLETED'
  | 'SAGA_COMPLETED'
  | 'SAGA_FAILED'
  | 'WORKFLOW_STATE_CHANGED';

export interface OutboxPayload {
  executionId: string;
  stepId?: string;
  stepIndex?: number;
  status?: string;
  output?: Record<string, unknown>;
  error?: Record<string, unknown>;
  timestamp: string;
  traceId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

export interface OutboxEvent {
  id: string;
  eventType: OutboxEventType;
  payload: OutboxPayload;
  status: 'pending' | 'processing' | 'processed' | 'failed';
  attempts: number;
  errorMessage?: string;
  createdAt: Date;
  processedAt?: Date;
  expiresAt?: Date;
}

// ============================================================================
// OUTBOX SERVICE
// ============================================================================

export class OutboxService {
  private redis: Redis;

  constructor(redis?: Redis) {
    this.redis = redis || getRedisClient(ServiceNamespace.SHARED);
  }

  /**
   * Publish an event to the outbox table
   * Should be called within a database transaction alongside business data writes
   *
   * @example
   * await db.transaction(async (tx) => {
   *   // 1. Write business data (e.g., reservation)
   *   await tx.insert(restaurantReservations).values(reservationData);
   *
   *   // 2. Write outbox event (same transaction)
   *   await outboxService.publish(tx, {
   *     eventType: 'SAGA_STEP_COMPLETED',
   *     payload: { executionId, stepId, status: 'completed', output }
   *   });
   * });
   */
  async publish(
    tx: any, // Transaction object from drizzle
    event: {
      eventType: OutboxEventType;
      payload: OutboxPayload;
      expiresInSeconds?: number;
    }
  ): Promise<string> {
    const eventId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = event.expiresInSeconds
      ? new Date(now.getTime() + event.expiresInSeconds * 1000)
      : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days default

    // Insert outbox record within the transaction
    await tx.insert(outbox).values({
      id: eventId,
      eventType: event.eventType,
      payload: event.payload,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      expiresAt,
    });

    console.log(`[OutboxService] Published event ${eventId} (${event.eventType}) for execution ${event.payload.executionId}`);
    return eventId;
  }

  /**
   * Process pending outbox events
   * Called by a background worker or relay service
   *
   * @param limit - Maximum number of events to process in one batch
   * @returns Number of events processed
   */
  async processPendingEvents(limit: number = 10): Promise<number> {
    const now = new Date();

    // Fetch pending events (oldest first)
    const pendingEvents = await db
      .select()
      .from(outbox)
      .where(sql`${outbox.status} = 'pending' AND ${outbox.expiresAt} > ${now}`)
      .orderBy(outbox.createdAt)
      .limit(limit);

    if (pendingEvents.length === 0) {
      return 0;
    }

    let processedCount = 0;

    for (const event of pendingEvents) {
      try {
        // Mark as processing
        await db
          .update(outbox)
          .set({
            status: 'processing',
            attempts: event.attempts + 1,
          })
          .where(sql`${outbox.id} = ${event.id}`);

        // Process the event (update Redis cache)
        await this.processEvent(event);

        // Mark as processed
        await db
          .update(outbox)
          .set({
            status: 'processed',
            processedAt: new Date(),
          })
          .where(sql`${outbox.id} = ${event.id}`);

        processedCount++;
      } catch (error) {
        console.error(`[OutboxService] Failed to process event ${event.id}:`, error);

        // Mark as failed if max attempts exceeded (3 attempts)
        if (event.attempts >= 3) {
          await db
            .update(outbox)
            .set({
              status: 'failed',
              errorMessage: error instanceof Error ? error.message : String(error),
            })
            .where(sql`${outbox.id} = ${event.id}`);
        } else {
          // Revert to pending for retry
          await db
            .update(outbox)
            .set({ status: 'pending' })
            .where(sql`${outbox.id} = ${event.id}`);
        }
      }
    }

    return processedCount;
  }

  /**
   * Process a single outbox event
   * Updates Redis cache based on event type
   */
  private async processEvent(event: Omit<OutboxEvent, 'id'> & { id: string }): Promise<void> {
    const { eventType, payload } = event;

    switch (eventType) {
      case 'SAGA_STEP_COMPLETED':
      case 'SAGA_STEP_FAILED': {
        // Update Redis cache for saga state
        const stateKey = `saga:state:${payload.executionId}`;
        const stateData = {
          stepId: payload.stepId,
          stepIndex: payload.stepIndex,
          status: payload.status,
          output: payload.output,
          error: payload.error,
          timestamp: payload.timestamp,
        };

        // Use Redis hash to store step state
        await this.redis.hset(stateKey, `${payload.stepIndex}`, JSON.stringify(stateData));
        await this.redis.expire(stateKey, 86400); // 24 hour TTL

        console.log(`[OutboxService] Updated Redis cache for step ${payload.stepIndex} (${payload.status})`);
        break;
      }

      case 'SAGA_COMPLETED':
      case 'SAGA_FAILED': {
        // Update saga completion status in Redis
        const completionKey = `saga:completion:${payload.executionId}`;
        await this.redis.setex(
          completionKey,
          86400,
          JSON.stringify({
            status: eventType === 'SAGA_COMPLETED' ? 'completed' : 'failed',
            timestamp: payload.timestamp,
            traceId: payload.traceId,
          })
        );
        break;
      }

      case 'WORKFLOW_STATE_CHANGED': {
        // Update workflow state cache
        const workflowKey = `workflow:state:${payload.executionId}`;
        await this.redis.setex(
          workflowKey,
          86400,
          JSON.stringify({
            status: payload.status,
            timestamp: payload.timestamp,
          })
        );
        break;
      }
    }
  }

  /**
   * Get outbox events by execution ID
   */
  async getEventsByExecutionId(executionId: string, limit: number = 10): Promise<OutboxEvent[]> {
    // Note: This requires querying JSONB payload - in production, consider adding execution_id column
    const events = await db
      .select()
      .from(outbox)
      .where(sql`${outbox.payload}->>'executionId' = ${executionId}`)
      .orderBy(outbox.createdAt)
      .limit(limit);

    return events;
  }

  /**
   * Clean up expired outbox events
   * Should be run periodically (e.g., daily cron job)
   */
  async cleanupExpiredEvents(): Promise<number> {
    const now = new Date();
    const result = await db.delete(outbox).where(sql`${outbox.expiresAt} < ${now}`);
    return result.rowCount || 0;
  }

  /**
   * Get outbox statistics
   */
  async getStats(): Promise<{
    pending: number;
    processing: number;
    processed: number;
    failed: number;
  }> {
    const stats = await db
      .select({
        status: outbox.status,
        count: sql<number>`count(*)`,
      })
      .from(outbox)
      .groupBy(outbox.status);

    const result = {
      pending: 0,
      processing: 0,
      processed: 0,
      failed: 0,
    };

    for (const stat of stats) {
      result[stat.status as keyof typeof result] = stat.count;
    }

    return result;
  }
}

// ============================================================================
// FACTORY
// ============================================================================

let defaultOutboxService: OutboxService | null = null;

export function getOutboxService(redis?: Redis): OutboxService {
  if (!defaultOutboxService) {
    defaultOutboxService = new OutboxService(redis);
  }
  return defaultOutboxService;
}
