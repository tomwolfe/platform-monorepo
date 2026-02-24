/**
 * Serverless Pub/Sub Bridge - Postgres Trigger to QStash HTTP
 *
 * Problem Solved: LISTEN/NOTIFY in Serverless Environments
 * - Traditional LISTEN/NOTIFY requires persistent PostgreSQL connections
 * - Vercel serverless functions are short-lived (10s timeout on Hobby tier)
 * - Cannot maintain persistent LISTEN connections
 *
 * Solution: Postgres Trigger + http_request Extension
 * - Uses PostgreSQL trigger to fire HTTP call on INSERT to outbox table
 * - Converts database event directly into QStash execution trigger
 * - No persistent listener or cron-job delay required
 *
 * Architecture:
 * 1. Create PostgreSQL function that calls http_request() extension
 * 2. Create trigger on outbox table that fires AFTER INSERT
 * 3. Trigger sends HTTP POST to QStash webhook URL
 * 4. QStash reliably delivers to /api/engine/outbox-relay endpoint
 *
 * Benefits:
 * - Zero-latency notification (fires immediately on commit)
 * - No polling overhead or consistency lag
 * - Reliable delivery via QStash retries
 * - Serverless-native (no persistent workers needed)
 *
 * SQL Migration Required:
 * ```sql
 * -- Enable http extension (Neon/Supabase)
 * CREATE EXTENSION IF NOT EXISTS http;
 *
 * -- Create function to send HTTP request
 * CREATE OR REPLACE FUNCTION notify_outbox_via_http()
 * RETURNS trigger AS $$
 * DECLARE
 *   qstash_url TEXT := 'https://qstash.upstash.io/v2/topics/outbox_events';
 *   qstash_token TEXT := current_setting('app.qstash_token', TRUE);
 *   payload_json TEXT;
 *   http_response RECORD;
 * BEGIN
 *   -- Build payload
 *   payload_json := json_build_object(
 *     'outboxId', NEW.id,
 *     'executionId', (NEW.payload->>'executionId'),
 *     'eventType', NEW.eventType,
 *     'timestamp', NOW()
 *   )::text;
 *
 *   -- Send HTTP POST to QStash
 *   SELECT * INTO http_response FROM http_post(
 *     qstash_url,
 *     payload_json,
 *     'application/json',
 *     ARRAY[
 *       http_header('Authorization', 'Bearer ' || qstash_token),
 *       http_header('Content-Type', 'application/json')
 *     ]
 *   );
 *
 *   -- Log result (optional)
 *   IF http_response.status_code != 200 THEN
 *     RAISE WARNING 'QStash notification failed: %', http_response.content;
 *   END IF;
 *
 *   RETURN NEW;
 * END;
 * $$ LANGUAGE plpgsql;
 *
 * -- Create trigger
 * DROP TRIGGER IF EXISTS outbox_http_notify ON outbox;
 * CREATE TRIGGER outbox_http_notify
 *   AFTER INSERT ON outbox
 *   FOR EACH ROW
 *   EXECUTE FUNCTION notify_outbox_via_http();
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { db, outbox } from '@repo/database';
import { sql, eq } from 'drizzle-orm';
import { QStashService } from './qstash';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface PubSubBridgeNotification {
  outboxId: string;
  executionId: string;
  eventType: string;
  timestamp: string;
}

export interface ServerlessBridgeConfig {
  /** QStash topic name (default: 'outbox_events') */
  qstashTopic?: string;
  /** Enable fallback polling if trigger fails */
  enableFallbackPolling?: boolean;
  /** Fallback polling interval in ms (default: 5000) */
  pollIntervalMs?: number;
}

const DEFAULT_CONFIG: Required<ServerlessBridgeConfig> = {
  qstashTopic: 'outbox_events',
  enableFallbackPolling: true,
  pollIntervalMs: 5000,
};

// ============================================================================
// SERVERLESS PUB/SUB BRIDGE
// ============================================================================

export class ServerlessPubSubBridge {
  private config: Required<ServerlessBridgeConfig>;

  constructor(config: ServerlessBridgeConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Trigger QStash delivery for an outbox event
   *
   * This is called automatically by the PostgreSQL trigger via http_request().
   * Can also be called manually as a fallback if the trigger fails.
   *
   * @param outboxId - Outbox event ID
   * @param executionId - Execution ID
   * @param eventType - Event type
   * @returns QStash message ID or null if failed
   */
  async triggerQStashDelivery(
    outboxId: string,
    executionId: string,
    eventType: string
  ): Promise<string | null> {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const url = `${baseUrl}/api/engine/outbox-relay`;

    const payload: PubSubBridgeNotification = {
      outboxId,
      executionId,
      eventType,
      timestamp: new Date().toISOString(),
    };

    const headers = {
      'Content-Type': 'application/json',
      'x-internal-system-key': process.env.INTERNAL_SYSTEM_KEY || '',
      'x-outbox-bridge': 'true',
    };

    try {
      const messageId = await QStashService.publish({
        url,
        body: payload,
        headers,
      });

      console.log(
        `[ServerlessPubSubBridge] Triggered QStash for outbox ${outboxId} ` +
        `(execution: ${executionId}, message: ${messageId})`
      );

      return messageId;
    } catch (error) {
      console.error(
        '[ServerlessPubSubBridge] Failed to trigger QStash:',
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }

  /**
   * Manually notify for pending outbox events (fallback mechanism)
   *
   * Used when:
   * 1. PostgreSQL http_request extension is not available
   * 2. Trigger fails due to network issues
   * 3. As a redundancy layer for critical events
   *
   * @param limit - Maximum events to process
   * @returns Number of events triggered
   */
  async notifyPendingEvents(limit: number = 10): Promise<number> {
    const now = new Date();

    // Fetch pending events (oldest first)
    const pendingEvents = await db
      .select()
      .from(outbox)
      .where(sql`
        ${outbox.status} = 'pending'
        AND (${outbox.expiresAt} > ${now} OR ${outbox.expiresAt} IS NULL)
      `)
      .orderBy(outbox.createdAt)
      .limit(limit);

    if (pendingEvents.length === 0) {
      return 0;
    }

    let triggeredCount = 0;

    for (const event of pendingEvents) {
      try {
        const executionId = (event.payload as any).executionId;
        const messageId = await this.triggerQStashDelivery(
          event.id,
          executionId,
          event.eventType
        );

        if (messageId) {
          triggeredCount++;
        }
      } catch (error) {
        console.error(
          `[ServerlessPubSubBridge] Failed to notify event ${event.id}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    console.log(
      `[ServerlessPubSubBridge] Notified ${triggeredCount}/${pendingEvents.length} pending events`
    );

    return triggeredCount;
  }

  /**
   * Setup database trigger for automatic notification
   *
   * This should be called once during database migration/setup.
   * Creates the PostgreSQL function and trigger for automatic HTTP notification.
   *
   * Note: Requires http extension (available in Neon/Supabase)
   */
  async setupTrigger(): Promise<void> {
    const qstashToken = process.env.QSTASH_TOKEN;

    if (!qstashToken) {
      console.warn(
        '[ServerlessPubSubBridge] QSTASH_TOKEN not configured. ' +
        'Trigger setup skipped.'
      );
      return;
    }

    try {
      // Set the qstash_token setting for use in PL/pgSQL
      await db.execute(sql`
        SELECT set_config('app.qstash_token', ${qstashToken}, FALSE)
      `);

      // Create the function and trigger
      // Note: In production, this should be in a migration file
      await db.execute(sql`
        -- Create function to send HTTP request via http extension
        CREATE OR REPLACE FUNCTION notify_outbox_via_http()
        RETURNS trigger AS $$
        DECLARE
          qstash_url TEXT := 'https://qstash.upstash.io/v2/topics/${this.config.qstashTopic}';
          qstash_token TEXT := current_setting('app.qstash_token', TRUE);
          payload_json TEXT;
          http_response RECORD;
        BEGIN
          -- Build payload
          payload_json := json_build_object(
            'outboxId', NEW.id,
            'executionId', (NEW.payload->>'executionId'),
            'eventType', NEW.eventType,
            'timestamp', NOW()
          )::text;

          -- Send HTTP POST to QStash
          SELECT * INTO http_response FROM http_post(
            qstash_url,
            payload_json,
            'application/json',
            ARRAY[
              http_header('Authorization', 'Bearer ' || qstash_token),
              http_header('Content-Type', 'application/json'),
              http_header('x-outbox-bridge', 'true')
            ]
          );

          -- Log result (optional)
          IF http_response.status_code != 200 THEN
            RAISE WARNING 'QStash notification failed: %', http_response.content;
          END IF;

          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);

      // Create trigger
      await db.execute(sql`
        DROP TRIGGER IF EXISTS outbox_http_notify ON outbox;
        CREATE TRIGGER outbox_http_notify
          AFTER INSERT ON outbox
          FOR EACH ROW
          EXECUTE FUNCTION notify_outbox_via_http();
      `);

      console.log(
        '[ServerlessPubSubBridge] Trigger setup complete. ' +
        'Outbox events will now trigger QStash notifications automatically.'
      );
    } catch (error) {
      console.error(
        '[ServerlessPubSubBridge] Trigger setup failed:',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  /**
   * Remove the database trigger
   *
   * Useful for cleanup or switching back to polling-only mode
   */
  async removeTrigger(): Promise<void> {
    try {
      await db.execute(sql`
        DROP TRIGGER IF EXISTS outbox_http_notify ON outbox;
        DROP FUNCTION IF EXISTS notify_outbox_via_http();
      `);

      console.log('[ServerlessPubSubBridge] Trigger removed successfully');
    } catch (error) {
      console.error(
        '[ServerlessPubSubBridge] Trigger removal failed:',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  /**
   * Check if http extension is available
   */
  async isHttpExtensionAvailable(): Promise<boolean> {
    try {
      const result = await db.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'http'
        ) as available
      `);

      return (result.rows[0] as any)?.available === true;
    } catch {
      return false;
    }
  }

  /**
   * Get bridge statistics
   */
  async getStats(): Promise<{
    httpExtensionAvailable: boolean;
    triggerExists: boolean;
    pendingEvents: number;
  }> {
    const httpAvailable = await this.isHttpExtensionAvailable();

    // Check if trigger exists
    const triggerResult = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'outbox_http_notify'
      ) as exists
    `);
    const triggerExists = (triggerResult.rows[0] as any)?.exists === true;

    // Count pending events
    const pendingResult = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM outbox
      WHERE status = 'pending'
    `);
    const pendingEvents = parseInt((pendingResult.rows[0] as any)?.count || '0', 10);

    return {
      httpExtensionAvailable: httpAvailable,
      triggerExists,
      pendingEvents,
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

let defaultBridge: ServerlessPubSubBridge | null = null;

export function getServerlessPubSubBridge(
  config?: ServerlessBridgeConfig
): ServerlessPubSubBridge {
  if (!defaultBridge) {
    defaultBridge = new ServerlessPubSubBridge(config);
  }
  return defaultBridge;
}

export function createServerlessPubSubBridge(
  config?: ServerlessBridgeConfig
): ServerlessPubSubBridge {
  return new ServerlessPubSubBridge(config);
}
