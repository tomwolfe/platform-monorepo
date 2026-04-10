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

import { getDb, outbox, outboxDlq, outboxStatusEnum } from "@repo/database";
import { sql, type PgTransaction, or, and, lt, eq } from "drizzle-orm";
import { neon } from "@neondatabase/serverless";
import { Redis } from "@upstash/redis";
import { getRedisClient, ServiceNamespace } from "./redis";
import { Logger } from "./logger";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type OutboxEventType =
  | "SAGA_STEP_COMPLETED"
  | "SAGA_STEP_FAILED"
  | "SAGA_COMPENSATION_TRIGGERED"
  | "SAGA_COMPENSATION_COMPLETED"
  | "SAGA_COMPLETED"
  | "SAGA_FAILED"
  | "WORKFLOW_STATE_CHANGED";

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
  status: "pending" | "processing" | "processed" | "failed";
  attempts: number;
  errorMessage?: string;
  createdAt: Date;
  processedAt?: Date;
  expiresAt?: Date;
}

// ============================================================================
// OUTBOX SERVICE
// ============================================================================

const logger = new Logger({ serviceName: "outbox-service" });

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
    tx: PgTransaction<any, any, any>,
    event: {
      eventType: OutboxEventType;
      payload: OutboxPayload;
      expiresInSeconds?: number;
    },
  ): Promise<string> {
    const eventId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = event.expiresInSeconds
      ? new Date(now.getTime() + event.expiresInSeconds * 1000)
      : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days default

    // Extract executionId from payload for top-level column indexing
    const executionId = event.payload.executionId || null;

    // Insert outbox record within the transaction
    await tx.insert(outbox).values({
      id: eventId,
      eventType: event.eventType,
      executionId,
      payload: event.payload,
      status: "pending",
      attempts: 0,
      createdAt: now,
      expiresAt,
    });

    logger.info({
      message: "Published outbox event",
      eventId,
      eventType: event.eventType,
      executionId: event.payload.executionId,
    });
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
    const db = getDb();
    const now = new Date();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    // Fetch pending events AND orphaned processing events (crashed workers)
    // An orphaned event is one that has been in 'processing' status for over 5 minutes
    const pendingEvents = await db
      .select()
      .from(outbox)
      .where(
        and(
          sql`${outbox.expiresAt} > ${now} OR ${outbox.expiresAt} IS NULL`,
          or(
            eq(outbox.status, "pending"),
            and(
              eq(outbox.status, "processing"),
              lt(outbox.createdAt, fiveMinutesAgo),
            ),
          ),
        ),
      )
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
            status: "processing",
            attempts: event.attempts + 1,
            updatedAt: new Date(),
          })
          .where(sql`${outbox.id} = ${event.id}`);

        // Process the event (update Redis cache)
        await this.processEvent(event);

        // Mark as processed
        await db
          .update(outbox)
          .set({
            status: "processed",
            processedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(sql`${outbox.id} = ${event.id}`);

        processedCount++;
      } catch (error: unknown) {
        logger.error({
          message: "Failed to process outbox event",
          eventId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });

        // Move to DLQ if max attempts exceeded (3 attempts)
        if (event.attempts >= 3) {
          // Atomic: insert into DLQ + delete from outbox in single transaction
          await db.transaction(async (tx) => {
            // Enforce timeout to prevent lock exhaustion in serverless
            await tx.execute(sql`SET LOCAL statement_timeout = '5000'`);

            await tx.insert(outboxDlq).values({
              id: crypto.randomUUID(),
              originalEventId: event.id,
              executionId: event.payload.executionId || null,
              eventType: event.eventType,
              payload: event.payload,
              status: "failed",
              attempts: event.attempts,
              errorMessage:
                error instanceof Error ? error.message : String(error),
              createdAt: event.createdAt,
              dlqCreatedAt: new Date(),
              expiresAt: event.expiresAt,
            });

            await tx.delete(outbox).where(eq(outbox.id, event.id));
          });

          logger.error({
            message: "Outbox event moved to DLQ after max retries",
            eventId: event.id,
            dlqEventId: event.id,
            attempts: event.attempts,
          });
        } else {
          // Revert to pending for retry
          await db
            .update(outbox)
            .set({ status: "pending", updatedAt: new Date() })
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
  private async processEvent(
    event: Omit<OutboxEvent, "id"> & { id: string },
  ): Promise<void> {
    const { eventType, payload } = event;

    switch (eventType) {
      case "SAGA_STEP_COMPLETED":
      case "SAGA_STEP_FAILED": {
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
        await this.redis.hset(stateKey, {
          [`${payload.stepIndex}`]: JSON.stringify(stateData),
        });
        await this.redis.expire(stateKey, 86400); // 24 hour TTL

        logger.info({
          message: "Updated Redis cache for saga step",
          executionId: payload.executionId,
          stepIndex: payload.stepIndex,
          status: payload.status,
        });
        break;
      }

      case "SAGA_COMPLETED":
      case "SAGA_FAILED": {
        // Update saga completion status in Redis
        const completionKey = `saga:completion:${payload.executionId}`;
        await this.redis.setex(
          completionKey,
          86400,
          JSON.stringify({
            status: eventType === "SAGA_COMPLETED" ? "completed" : "failed",
            timestamp: payload.timestamp,
            traceId: payload.traceId,
          }),
        );
        break;
      }

      case "WORKFLOW_STATE_CHANGED": {
        // Update workflow state cache
        const workflowKey = `workflow:state:${payload.executionId}`;
        await this.redis.setex(
          workflowKey,
          86400,
          JSON.stringify({
            status: payload.status,
            timestamp: payload.timestamp,
          }),
        );
        break;
      }
    }
  }

  /**
   * Get outbox events by execution ID
   */
  async getEventsByExecutionId(
    executionId: string,
    limit: number = 10,
  ): Promise<OutboxEvent[]> {
    const db = getDb();
    const events = await db
      .select()
      .from(outbox)
      .where(eq(outbox.executionId, executionId))
      .orderBy(outbox.createdAt)
      .limit(limit);

    return events;
  }

  /**
   * Get dead-letter queue events for inspection
   */
  async getDlqEvents(
    limit: number = 50,
  ): Promise<Array<OutboxEvent & { dlqCreatedAt: Date }>> {
    const db = getDb();
    const events = await db
      .select()
      .from(outboxDlq)
      .orderBy(outboxDlq.dlqCreatedAt)
      .limit(limit);

    return events;
  }

  /**
   * Retry a DLQ event by moving it back to the main outbox table
   */
  async retryDlqEvent(dlqEventId: string): Promise<boolean> {
    const db = getDb();

    // Get the DLQ event
    const dlqEvent = await db
      .select()
      .from(outboxDlq)
      .where(eq(outboxDlq.id, dlqEventId))
      .limit(1);

    if (dlqEvent.length === 0) {
      return false;
    }

    const event = dlqEvent[0];

    // Atomic: insert back into outbox + delete from DLQ in single transaction
    await db.transaction(async (tx) => {
      // Enforce timeout to prevent lock exhaustion in serverless
      await tx.execute(sql`SET LOCAL statement_timeout = '5000'`);

      await tx.insert(outbox).values({
        id: crypto.randomUUID(),
        eventType: event.eventType,
        payload: event.payload,
        status: "pending",
        attempts: 0,
        createdAt: new Date(),
        expiresAt: event.expiresAt,
      });

      await tx.delete(outboxDlq).where(eq(outboxDlq.id, dlqEventId));
    });

    logger.info({
      message: "DLQ event retried",
      dlqEventId,
    });

    return true;
  }

  /**
   * Clean up expired outbox events
   * Should be run periodically (e.g., daily cron job)
   */
  async cleanupExpiredEvents(): Promise<number> {
    const now = new Date();
    const result = await getDb()
      .delete(outbox)
      .where(sql`${outbox.expiresAt} < ${now}`);
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
    const stats = await getDb()
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
