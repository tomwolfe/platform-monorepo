/**
 * Outbox Relay Service - Self-Triggering Outbox Pattern
 *
 * Problem Solved: The "Outbox Relay Problem"
 * - You have the `outbox` table, but who is the "Relay" in serverless?
 * - Cron job every 5 minutes = slow Saga execution
 * - No persistent worker = missing "Push" from Postgres to Redis
 *
 * Solution: Fire-and-Forget QStash Trigger
 * - After DB transaction commits in API route, trigger QStash call to /api/engine/outbox-relay
 * - QStash provides near-instant state sync (like persistent worker) with serverless cost model
 * - Only pays when used, no idle worker costs
 *
 * Architecture:
 * 1. API route commits transaction with outbox event
 * 2. Fire-and-forget QStash trigger to /api/engine/outbox-relay
 * 3. Outbox relay processes pending events and updates Redis cache
 * 4. QStash handles retries if relay fails
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { QStashService } from './services/qstash';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface OutboxRelayConfig {
  /** QStash internal system key for auth */
  internalKey?: string;
  /** Base URL for callbacks (defaults to NEXT_PUBLIC_APP_URL) */
  baseUrl?: string;
  /** Enable/disable QStash (fallback for local dev) */
  enabled?: boolean;
  /** Trace context for distributed tracing */
  traceId?: string;
  /** Correlation ID for request correlation */
  correlationId?: string;
}

export interface OutboxRelayTriggerResult {
  /** Whether QStash trigger was successful */
  success: boolean;
  /** QStash message ID if triggered */
  messageId?: string | null;
  /** Whether fallback was used */
  fallbackUsed: boolean;
  /** Error message if failed */
  error?: string;
}

// ============================================================================
// OUTBOX RELAY SERVICE
// ============================================================================

export class OutboxRelayService {
  private static config: OutboxRelayConfig | null = null;

  /**
   * Initialize the Outbox Relay Service
   * Call once at application startup
   */
  static initialize(config: OutboxRelayConfig = {}): void {
    this.config = {
      internalKey: config.internalKey || process.env.INTERNAL_SYSTEM_KEY,
      baseUrl: config.baseUrl || process.env.NEXT_PUBLIC_APP_URL,
      enabled: config.enabled ?? true,
      traceId: config.traceId,
      correlationId: config.correlationId,
    };
  }

  /**
   * Trigger outbox relay after DB transaction commit
   * Fire-and-forget pattern - does not wait for relay to complete
   *
   * @param executionId - Execution ID to process outbox for
   * @param config - Optional configuration override
   * @returns Result of the trigger attempt
   *
   * @example
   * // In API route after DB transaction
   * await db.transaction(async (tx) => {
   *   // 1. Write business data
   *   await tx.insert(restaurantReservations).values(reservationData);
   *
   *   // 2. Write outbox event
   *   await outboxService.publish(tx, {
   *     eventType: 'SAGA_STEP_COMPLETED',
   *     payload: { executionId, stepId, status: 'completed', output }
   *   });
   * });
   *
   * // 3. Trigger outbox relay (fire-and-forget)
   * await OutboxRelayService.triggerRelay(executionId);
   */
  static async triggerRelay(
    executionId: string,
    config?: OutboxRelayConfig
  ): Promise<OutboxRelayTriggerResult> {
    const effectiveConfig = { ...this.config, ...config };

    try {
      // Use QStash for reliable delivery
      const url = `${effectiveConfig.baseUrl || 'http://localhost:3000'}/api/engine/outbox-relay`;
      const payload = JSON.stringify({
        executionId,
        timestamp: new Date().toISOString(),
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Add internal system key for auth
      if (effectiveConfig.internalKey) {
        headers['x-internal-system-key'] = effectiveConfig.internalKey;
      }

      // Propagate trace context
      if (effectiveConfig.traceId) {
        headers['x-trace-id'] = effectiveConfig.traceId;
      }
      if (effectiveConfig.correlationId) {
        headers['x-correlation-id'] = effectiveConfig.correlationId;
      }

      // Trigger QStash
      const messageId = await QStashService.publish({
        url,
        body: payload,
        headers,
      });

      console.log(
        `[OutboxRelay] Triggered relay for execution ${executionId}` +
        (messageId ? ` [message: ${messageId}]` : '') +
        (effectiveConfig.traceId ? ` [trace: ${effectiveConfig.traceId}]` : '')
      );

      return {
        success: true,
        messageId,
        fallbackUsed: false,
      };
    } catch (error) {
      console.error('[OutboxRelay] Failed to trigger relay:', error);

      // In production, throw to let caller handle
      if (process.env.NODE_ENV === 'production') {
        return {
          success: false,
          messageId: null,
          fallbackUsed: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      // Development: try fallback fetch
      try {
        await this.fallbackFetch(executionId, effectiveConfig);
        return {
          success: true,
          messageId: null,
          fallbackUsed: true,
        };
      } catch (fallbackError) {
        return {
          success: false,
          messageId: null,
          fallbackUsed: true,
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        };
      }
    }
  }

  /**
   * Fallback to direct fetch when QStash is not configured
   * Fire-and-forget using setTimeout to not block response
   */
  private static async fallbackFetch(
    executionId: string,
    config: OutboxRelayConfig
  ): Promise<void> {
    const url = `${config.baseUrl || 'http://localhost:3000'}/api/engine/outbox-relay`;

    // Use setTimeout for non-blocking fire-and-forget
    setTimeout(async () => {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        if (config.internalKey) {
          headers['x-internal-system-key'] = config.internalKey;
        }

        if (config.traceId) {
          headers['x-trace-id'] = config.traceId;
        }
        if (config.correlationId) {
          headers['x-correlation-id'] = config.correlationId;
        }

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            executionId,
            timestamp: new Date().toISOString(),
          }),
        });

        if (!response.ok) {
          console.error(
            `[OutboxRelay:Fallback] Failed to trigger relay: ${response.status} ${response.statusText}`
          );
        } else {
          console.log(`[OutboxRelay:Fallback] Relay triggered successfully`);
        }
      } catch (error) {
        console.error(`[OutboxRelay:Fallback] Error triggering relay:`, error);
      }
    }, 100); // 100ms delay to allow response to complete
  }

  /**
   * Get configuration status
   */
  static isConfigured(): boolean {
    return this.config !== null && this.config.enabled !== false;
  }

  /**
   * Get current configuration
   */
  static getConfig(): OutboxRelayConfig | null {
    return this.config;
  }
}

// ============================================================================
// QSTASH PUBLISH WRAPPER
// Helper for publishing to QStash with proper typing
// ============================================================================

/**
 * Publish a message to QStash
 * This is a helper function that wraps QStashService.triggerNextStep
 * for generic URL publishing (not just execute-step)
 */
export async function publishToQStash(options: {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
}): Promise<string | null> {
  // Import dynamically to avoid circular dependencies
  const { Client } = await import('@upstash/qstash');

  const token = process.env.QSTASH_TOKEN || process.env.UPSTASH_QSTASH_TOKEN;

  if (!token) {
    console.warn('[publishToQStash] QStash token not configured');
    return null;
  }

  const client = new Client({ token });

  try {
    const result = await client.publish({
      url: options.url,
      body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
      headers: options.headers || { 'Content-Type': 'application/json' },
    });

    const messageId = 'messageId' in result ? result.messageId : undefined;
    return messageId || null;
  } catch (error) {
    console.error('[publishToQStash] Failed to publish:', error);
    throw error;
  }
}

// Auto-initialize on import if environment variables are present
if (typeof process !== 'undefined' && typeof process.env !== 'undefined') {
  const internalKey = process.env.INTERNAL_SYSTEM_KEY;
  if (internalKey) {
    OutboxRelayService.initialize({ internalKey });
  }
}
