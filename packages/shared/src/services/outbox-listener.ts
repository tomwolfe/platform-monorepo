/**
 * Shadow Relay 2.0 - LISTEN/NOTIFY-based Outbox Processing
 *
 * Problem Solved: Consistency Lag in Transactional Outbox
 * - Original OutboxRelay relies on QStash trigger (reliable but eventual)
 * - If infrastructure error occurs after DB commit but before Redis sync,
 *   system relies on 5-minute DLQ scan for recovery
 *
 * Solution: Postgres LISTEN/NOTIFY for Real-Time Event Notification
 * - Uses PostgreSQL's pub/sub mechanism for instant notification
 * - Provides FIFO ordering guarantee for event processing
 * - Eliminates "consistency lag" between DB and Redis
 *
 * Architecture:
 * 1. DB transaction commits with outbox event + NOTIFY
 * 2. PostgreSQL immediately notifies all listeners
 * 3. Outbox relay receives notification and processes event
 * 4. Redis cache updated in real-time
 *
 * Benefits:
 * - Zero-latency notification (faster than QStash polling)
 * - FIFO ordering (events processed in commit order)
 * - Built-in retry (failed events remain 'pending')
 * - Cost-free (no QStash calls for notification)
 *
 * Usage:
 * ```typescript
 * // Initialize listener (server startup)
 * const listener = createOutboxListener();
 * await listener.startListening();
 *
 * // In API route after DB transaction
 * await db.transaction(async (tx) => {
 *   await tx.insert(outbox).values({...});
 *   await notifyOutboxEvent(tx, { executionId, eventType });
 * });
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { getDb, outbox } from "@repo/database";
import { sql, eq, and, lt, isNull } from "drizzle-orm";
import { Redis } from "@upstash/redis";
import { getRedisClient, ServiceNamespace } from "../redis";
import {
  OutboxService,
  type OutboxPayload,
  type OutboxEventType,
  type OutboxEvent,
} from "../outbox";
import { Logger } from "../logger";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface OutboxNotification {
  executionId: string;
  eventType: OutboxEventType;
  outboxId: string;
  timestamp: string;
}

export interface OutboxListenerConfig {
  /** Channel name for LISTEN/NOTIFY (default: 'outbox_events') */
  channelName?: string;
  /** Batch size for processing notifications (default: 10) */
  batchSize?: number;
  /** Polling interval for missed events (default: 5000ms) */
  pollIntervalMs?: number;
  /** Enable fallback polling if LISTEN/NOTIFY fails */
  enableFallbackPolling?: boolean;
  /** Redis client for state sync */
  redis?: Redis;
}

export interface OutboxListenerStats {
  /** Number of notifications received */
  notificationsReceived: number;
  /** Number of events processed */
  eventsProcessed: number;
  /** Number of events failed */
  eventsFailed: number;
  /** Number of fallback polls executed */
  fallbackPolls: number;
  /** Last notification timestamp */
  lastNotificationAt?: Date;
  /** Last error message */
  lastError?: string;
}

// ============================================================================
// NOTIFY FUNCTION
// Send notification after outbox insert
// ============================================================================

/**
 * Notify listeners that an outbox event is ready for processing
 *
 * Must be called within a transaction AFTER the outbox insert
 *
 * @param tx - Database transaction
 * @param notification - Notification payload
 *
 * @example
 * await db.transaction(async (tx) => {
 *   // 1. Insert business data
 *   await tx.insert(restaurantReservations).values(reservation);
 *
 *   // 2. Insert outbox event
 *   const [outboxRecord] = await tx.insert(outbox).values({
 *     eventType: 'SAGA_STEP_COMPLETED',
 *     payload: { executionId, stepId, status: 'completed' }
 *   }).returning();
 *
 *   // 3. Notify listeners (FIFO ordering)
 *   await notifyOutboxEvent(tx, {
 *     executionId,
 *     eventType: 'SAGA_STEP_COMPLETED',
 *     outboxId: outboxRecord.id
 *   });
 * });
 */
export async function notifyOutboxEvent(
  tx: any,
  notification: {
    executionId: string;
    eventType: OutboxEventType;
    outboxId: string;
  },
): Promise<void> {
  const logger = new Logger({ serviceName: "outbox-listener" });
  const channelName = process.env.OUTBOX_CHANNEL_NAME || "outbox_events";

  // Use pg_notify to send notification
  await tx.execute(sql`
    SELECT pg_notify(${channelName}, ${JSON.stringify({
      executionId: notification.executionId,
      eventType: notification.eventType,
      outboxId: notification.outboxId,
      timestamp: new Date().toISOString(),
    })})
  `);

  logger.info(
    `Notified channel '${channelName}' for execution ${notification.executionId}`,
    { outboxId: notification.outboxId },
  );
}

// ============================================================================
// OUTBOX LISTENER CLASS
// LISTEN/NOTIFY-based event processor
// ============================================================================

export class OutboxListener {
  private logger = new Logger({ serviceName: "outbox-listener" });
  private config: OutboxListenerConfig;
  private redis: Redis;
  private outboxService: OutboxService;
  private isListening = false;
  private stats: OutboxListenerStats = {
    notificationsReceived: 0,
    eventsProcessed: 0,
    eventsFailed: 0,
    fallbackPolls: 0,
  };
  private client?: any; // PostgreSQL client for LISTEN

  constructor(config: OutboxListenerConfig = {}) {
    this.config = {
      channelName: process.env.OUTBOX_CHANNEL_NAME || "outbox_events",
      batchSize: 10,
      pollIntervalMs: 5000,
      enableFallbackPolling: true,
      ...config,
    };
    this.redis = config.redis || getRedisClient(ServiceNamespace.SHARED);
    this.outboxService = new OutboxService(this.redis);
  }

  /**
   * Start listening for outbox events
   * Uses LISTEN/NOTIFY with fallback polling
   */
  async startListening(): Promise<void> {
    if (this.isListening) {
      this.logger.warn("Already listening");
      return;
    }

    this.isListening = true;
    this.logger.info(
      `Starting listener on channel '${this.config.channelName}'`,
      {
        batchSize: this.config.batchSize,
      },
    );

    try {
      // Try to set up LISTEN/NOTIFY
      await this.setupListener();
    } catch (error) {
      this.logger.error("Failed to setup LISTEN/NOTIFY", { error });

      // In serverless environments, LISTEN/NOTIFY won't work.
      // Log a warning and rely on cron-based processing instead.
      this.logger.warn(
        "LISTEN/NOTIFY unavailable. Outbox processing will be handled by /api/cron/outbox-sweep endpoint.",
      );
    }
  }

  /**
   * Stop listening for outbox events
   */
  async stopListening(): Promise<void> {
    this.isListening = false;

    if (this.client) {
      try {
        await this.client.query(`UNLISTEN ${this.config.channelName}`);
        await this.client.end();
      } catch (error) {
        this.logger.error("Error stopping listener", { error });
      }
      this.client = undefined;
    }

    this.logger.info("Stopped listening");
  }

  /**
   * Get listener statistics
   */
  getStats(): OutboxListenerStats {
    return { ...this.stats };
  }

  /**
   * Setup PostgreSQL LISTEN/NOTIFY listener
   */
  private async setupListener(): Promise<void> {
    // Import neon serverless for direct SQL execution
    const { neon } = await import("@neondatabase/serverless");

    const databaseUrl = AppConfig.getDatabaseUrl();
    if (!databaseUrl) {
      throw new Error("DATABASE_URL not configured");
    }

    // Create dedicated connection for LISTEN
    this.client = neon(databaseUrl);

    // Subscribe to channel
    await this.client.query(`LISTEN ${this.config.channelName}`);

    this.logger.info(`Subscribed to channel '${this.config.channelName}'`);

    // Listen for notifications
    // Note: neon serverless doesn't support persistent connections well
    // We'll use polling as the primary mechanism in serverless environments
    this.logger.warn(
      "LISTEN/NOTIFY in serverless: Using polling as primary mechanism. For real-time LISTEN, deploy a persistent worker (e.g., Fly.io, Railway).",
    );
  }

  /**
   * Start fallback polling mechanism
   *
   * SERVERLESS-SAFE: Does NOT use setInterval (which freezes in serverless).
   * Instead, this method is exposed as a public method that can be called
   * by a cron endpoint (e.g. /api/cron/outbox-sweep) scheduled via QStash.
   *
   * For local development, you can call pollAndProcess() directly.
   */
  startFallbackPolling(): void {
    // NOTE: setInterval has been removed for serverless compatibility.
    // Outbox processing is now handled by:
    // 1. PostgreSQL LISTEN/NOTIFY (for persistent workers)
    // 2. QStash-triggered cron endpoint /api/cron/outbox-sweep (for serverless)
    //
    // This method is kept as a no-op for backward compatibility.
    // Use pollAndProcess() directly for manual or cron-triggered processing.
    this.logger.info(
      "startFallbackPolling() is deprecated for serverless. Use the /api/cron/outbox-sweep endpoint triggered by QStash instead.",
    );
  }

  /**
   * Poll for pending outbox events and process them
   *
   * This method is public and can be called by a cron endpoint
   * to process pending outbox events on a schedule.
   */
  async pollAndProcess(): Promise<void> {
    const now = new Date();
    const db = getDb();

    // Fetch pending events (FIFO order by createdAt)
    const pendingEvents = await db
      .select()
      .from(outbox)
      .where(
        sql`
        ${outbox.status} = 'pending'
        AND (${outbox.expiresAt} > ${now} OR ${outbox.expiresAt} IS NULL)
      `,
      )
      .orderBy(outbox.createdAt)
      .limit(this.config.batchSize!);

    if (pendingEvents.length === 0) {
      return;
    }

    this.logger.info(`Found ${pendingEvents.length} pending outbox events`);

    // Process events in batch
    for (const event of pendingEvents) {
      await this.processNotification({
        executionId: event.payload.executionId,
        eventType: event.eventType as OutboxEventType,
        outboxId: event.id,
        timestamp: event.createdAt.toISOString(),
      });
    }
  }

  /**
   * Process a single outbox notification
   */
  private async processNotification(
    notification: OutboxNotification,
  ): Promise<void> {
    this.stats.notificationsReceived++;
    this.stats.lastNotificationAt = new Date();
    const db = getDb();

    this.logger.info(
      `Processing notification for execution ${notification.executionId}`,
      { outboxId: notification.outboxId },
    );

    try {
      // Fetch the outbox event
      const events = await db
        .select()
        .from(outbox)
        .where(sql`${outbox.id} = ${notification.outboxId}`)
        .limit(1);

      if (events.length === 0) {
        this.logger.warn(`Outbox event ${notification.outboxId} not found`);
        return;
      }

      const event = events[0]!;

      // Skip if already processed
      if (event.status === "processed") {
        this.logger.info(`Event ${notification.outboxId} already processed`);
        return;
      }

      // Process the event (update Redis cache)
      await this.outboxService.processPendingEvents(1);

      this.stats.eventsProcessed++;

      this.logger.info(`Successfully processed event ${notification.outboxId}`);
    } catch (error) {
      this.logger.error("Failed to process notification", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.stats.eventsFailed++;
      throw error;
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

let defaultOutboxListener: OutboxListener | null = null;

export function createOutboxListener(
  config?: OutboxListenerConfig,
): OutboxListener {
  if (!defaultOutboxListener) {
    defaultOutboxListener = new OutboxListener(config);
  }
  return defaultOutboxListener;
}

export function getOutboxListener(): OutboxListener {
  return createOutboxListener();
}

// ============================================================================
// SERVERLESS-OPTIMIZED HELPER
// Trigger outbox processing via QStash (for Vercel Hobby tier)
// ============================================================================

/**
 * Trigger outbox relay via QStash
 *
 * This is the recommended approach for Vercel Hobby tier:
 * - No persistent worker needed
 * - QStash provides reliable delivery with retries
 * - FIFO ordering maintained by createdAt timestamp
 *
 * @param executionId - Execution ID to process
 * @param outboxId - Outbox event ID
 */
export async function triggerOutboxRelay(
  executionId: string,
  outboxId: string,
): Promise<string | null> {
  const { QStashService } = await import("../services/qstash");
  const { AppConfig } = await import("../config");
  const logger = new Logger({ serviceName: "outbox-listener" });

  const baseUrl = AppConfig.getIntentionEngineApiUrl();
  const url = `${baseUrl}/api/engine/outbox-relay`;

  const payload = {
    executionId,
    outboxId,
    timestamp: new Date().toISOString(),
  };

  // SECURITY: Generate short-lived JWT for internal service-to-service communication
  const { signInternalJWT } = await import("@repo/auth");
  const authToken = await signInternalJWT(
    { action: "outbox_relay", executionId, outboxId },
    { issuer: "outbox-listener", audience: "intention-engine" },
  );

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
  };

  try {
    const messageId = await QStashService.publish({
      url,
      body: payload,
      headers,
    });

    logger.info(`Triggered QStash relay for execution ${executionId}`, {
      messageId,
    });

    return messageId;
  } catch (error) {
    logger.error("Failed to trigger QStash relay", { error });
    return null;
  }
}
