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

import { QStashService } from "./services/qstash";
import { signAsymmetricJWT } from "@repo/auth";
import { Logger } from "./logger";

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
    config?: OutboxRelayConfig,
  ): Promise<OutboxRelayTriggerResult> {
    const effectiveConfig = { ...this.config, ...config };

    try {
      // Use QStash for reliable delivery
      const { AppConfig } = await import("./config");
      const url = `${effectiveConfig.baseUrl || AppConfig.getIntentionEngineApiUrl()}/api/engine/outbox-relay`;
      const payload = JSON.stringify({
        executionId,
        timestamp: new Date().toISOString(),
      });

      // SECURITY: Generate short-lived asymmetric JWT (RS256) for
      // Zero-Trust internal service-to-service communication
      const authToken = await signAsymmetricJWT(
        {
          service: "outbox-relay",
          executionId,
          action: "trigger-relay",
        },
        {
          issuer: "shared-outbox-relay",
          audience: "intention-engine",
          expiresIn: "5m",
        },
      );

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      };

      // Propagate trace context
      if (effectiveConfig.traceId) {
        headers["x-trace-id"] = effectiveConfig.traceId;
      }
      if (effectiveConfig.correlationId) {
        headers["x-correlation-id"] = effectiveConfig.correlationId;
      }

      // Trigger QStash
      const messageId = await QStashService.publish({
        url,
        body: payload,
        headers,
      });

      const logger = new Logger({ serviceName: "outbox-relay" });
      logger.info({
        message: "Triggered outbox relay for execution",
        executionId,
        messageId: messageId || undefined,
        traceId: effectiveConfig.traceId,
      });

      return {
        success: true,
        messageId,
        fallbackUsed: false,
      };
    } catch (error) {
      const logger = new Logger({ serviceName: "outbox-relay" });
      logger.error({
        message: "Failed to trigger outbox relay",
        executionId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // In production, throw to let caller handle
      if (process.env.NODE_ENV === "production") {
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
          error:
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError),
        };
      }
    }
  }

  /**
   * Fallback to direct fetch when QStash is not configured
   * Uses Next.js after() API to safely execute in background without Vercel killing the process.
   * If running in a non-Next.js context, falls back to microtask execution.
   */
  private static async fallbackFetch(
    executionId: string,
    config: OutboxRelayConfig,
  ): Promise<void> {
    const baseUrl =
      config.baseUrl ||
      (process.env.NODE_ENV === "production"
        ? undefined
        : "http://localhost:3000");
    if (!baseUrl) {
      throw new Error(
        "CRITICAL: Outbox relay baseUrl is undefined in production environment.",
      );
    }
    const url = `${baseUrl}/api/engine/outbox-relay`;

    // SECURITY: Generate short-lived asymmetric JWT (RS256) for
    // Zero-Trust internal service-to-service communication
    const authToken = await signAsymmetricJWT(
      {
        service: "outbox-relay",
        executionId,
        action: "trigger-relay",
      },
      {
        issuer: "shared-outbox-relay",
        audience: "intention-engine",
        expiresIn: "5m",
      },
    );

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${authToken}`,
    };

    if (config.traceId) {
      headers["x-trace-id"] = config.traceId;
    }
    if (config.correlationId) {
      headers["x-correlation-id"] = config.correlationId;
    }

    const fetchLogic = async () => {
      const logger = new Logger({ serviceName: "outbox-relay-fallback" });
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            executionId,
            timestamp: new Date().toISOString(),
          }),
        });

        if (!response.ok) {
          logger.error({
            message: "Failed to trigger outbox relay via fallback",
            executionId,
            httpStatus: response.status,
          });
        } else {
          logger.info({
            message: "Outbox relay fallback triggered successfully",
            executionId,
          });
        }
      } catch (error) {
        logger.error({
          message: "Error triggering outbox relay fallback",
          executionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    // Try Next.js after() API first for proper background execution in Vercel serverless
    // If not available (non-Next.js runtime), fall back to microtask execution
    try {
      const { after } = await import("next/server");
      after(fetchLogic);
    } catch {
      // Fallback for non-Next.js environments (raw Node scripts, other frameworks)
      const logger = new Logger({ serviceName: "outbox-relay-fallback" });
      Promise.resolve()
        .then(fetchLogic)
        .catch((err) =>
          logger.error({
            message: "Unhandled outbox relay fallback error",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }
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
  const { Client } = await import("@upstash/qstash");

  const token = process.env.QSTASH_TOKEN || process.env.UPSTASH_QSTASH_TOKEN;

  if (!token) {
    const logger = new Logger({ serviceName: "outbox-relay" });
    logger.warn({ message: "QStash token not configured" });
    return null;
  }

  const client = new Client({ token });

  try {
    const result = await client.publish({
      url: options.url,
      body:
        typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body),
      headers: options.headers || { "Content-Type": "application/json" },
    });

    const messageId = "messageId" in result ? result.messageId : undefined;
    return messageId || null;
  } catch (error) {
    const logger = new Logger({ serviceName: "outbox-relay" });
    logger.error({
      message: "Failed to publish to QStash",
      url: options.url,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Auto-initialize on import if environment variables are present
if (typeof process !== "undefined" && typeof process.env !== "undefined") {
  const internalKey = process.env.INTERNAL_SYSTEM_KEY;
  if (internalKey) {
    OutboxRelayService.initialize({ internalKey });
  }
}
