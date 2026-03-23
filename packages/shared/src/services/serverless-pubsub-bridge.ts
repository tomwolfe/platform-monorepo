/**
 * Serverless Pub/Sub Bridge - Fallback Polling Implementation
 *
 * Problem Solved: LISTEN/NOTIFY in Serverless Environments
 * - Traditional LISTEN/NOTIFY requires persistent PostgreSQL connections
 * - Vercel serverless functions are short-lived (10s timeout on Hobby tier)
 * - Cannot maintain persistent LISTEN connections
 *
 * Solution: Fallback Polling Mechanism
 * - Relies purely on notifyPendingEvents() polling mechanism
 * - No PostgreSQL http_request extension required
 * - Portable across all Postgres providers (no vendor lock-in)
 *
 * Architecture:
 * 1. Outbox events are inserted with 'pending' status
 * 2. Background polling checks for pending events
 * 3. Polling triggers QStash delivery via HTTP POST
 * 4. QStash reliably delivers to /api/engine/outbox-relay endpoint
 *
 * Benefits:
 * - No database extension dependencies
 * - Fully portable across Postgres providers
 * - Easier to debug (no PL/pgSQL triggers)
 * - Configurable polling interval
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import type { Database, OutboxTable } from '../types/database';
import { sql, eq } from 'drizzle-orm';
import { outbox } from '@repo/database';
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
  enableFallbackPolling: true, // CRITICAL: Always use fallback polling (no http extension)
  pollIntervalMs: 5000,
};

// ============================================================================
// SERVERLESS PUB/SUB BRIDGE
// ============================================================================

export class ServerlessPubSubBridge {
  private config: Required<ServerlessBridgeConfig>;
  private db: Database;

  constructor(db: Database, config: ServerlessBridgeConfig = {}) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Trigger QStash delivery for an outbox event
   *
   * This is the primary method for notifying QStash of pending outbox events.
   * Uses pure HTTP polling - no database triggers required.
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
    const pendingEvents = await this.db
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
   * Get bridge statistics
   */
  async getStats(): Promise<{
    pendingEvents: number;
  }> {
    // Count pending events
    const pendingResult = await this.db.execute(sql`
      SELECT COUNT(*) as count
      FROM outbox
      WHERE status = 'pending'
    `);
    const pendingEvents = parseInt((pendingResult.rows[0] as any)?.count || '0', 10);

    return {
      pendingEvents,
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

let defaultBridge: ServerlessPubSubBridge | null = null;

export function getServerlessPubSubBridge(
  db: Database,
  config?: ServerlessBridgeConfig
): ServerlessPubSubBridge {
  if (!defaultBridge) {
    defaultBridge = new ServerlessPubSubBridge(db, config);
  }
  return defaultBridge;
}

export function createServerlessPubSubBridge(
  db: Database,
  config?: ServerlessBridgeConfig
): ServerlessPubSubBridge {
  return new ServerlessPubSubBridge(db, config);
}
