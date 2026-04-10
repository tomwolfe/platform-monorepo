/**
 * Dispatch Queue Service
 *
 * Replaces unreliable Next.js `after()` hooks with QStash-based queue publishing.
 * This ensures background tasks (emails, cache invalidation, webhooks) are
 * reliably executed even in Vercel serverless environments.
 *
 * Usage:
 *   await dispatchTask('send_reservation_email', payload, idempotencyKey);
 *   await dispatchTask('invalidate_availability_cache', payload, idempotencyKey);
 *   await dispatchTask('send_checkout_webhook', payload, idempotencyKey);
 */

import { QStashService } from "../services/qstash";
import { Logger } from "../logger";

const logger = new Logger({ serviceName: "dispatch-queue" });

export type DispatchTask =
  | "send_reservation_email"
  | "invalidate_availability_cache"
  | "send_checkout_webhook";

export interface ReservationEmailPayload {
  reservationId: string;
  guestEmail: string;
  guestName: string;
  restaurantName: string;
  partySize: number;
  startTime: string;
  verificationToken: string;
  isShadow: boolean;
  ownerEmail?: string;
  claimToken?: string;
  origin: string;
}

export interface CacheInvalidationPayload {
  restaurantId: string;
}

export interface CheckoutWebhookPayload {
  webhookUrl: string;
  reservationId: string;
  txHash: string;
  status: string;
  message: string;
}

export type DispatchPayload =
  | ReservationEmailPayload
  | CacheInvalidationPayload
  | CheckoutWebhookPayload;

/**
 * Dispatch a background task via QStash
 *
 * This method publishes a message to QStash which will then trigger the
 * `/api/cron/dispatch` endpoint with automatic retries on failure.
 *
 * @param task - Task type identifier
 * @param payload - Task-specific payload
 * @param idempotencyKey - Unique key to prevent duplicate processing
 * @returns Message ID if successful, null in dev mode with fallback
 *
 * @example
 * ```typescript
 * await dispatchTask('send_reservation_email', {
 *   reservationId: 'res_123',
 *   guestEmail: 'john@example.com',
 *   // ... other fields
 * }, 'unique-key-123');
 * ```
 */
export async function dispatchTask(
  task: DispatchTask,
  payload: DispatchPayload,
  idempotencyKey: string,
): Promise<string | null> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

  const dispatchUrl = `${baseUrl}/api/cron/dispatch`;

  try {
    // Try QStash first
    const client = QStashService["getClient"]();

    if (client && QStashService["config"]?.enabled) {
      // Use QStash for reliable delivery
      const response = await client.publishJSON({
        url: dispatchUrl,
        body: { task, payload },
        headers: {
          "Idempotency-Key": idempotencyKey,
          "Content-Type": "application/json",
        },
        retries: 3,
      });

      logger.info("Task dispatched via QStash", {
        task,
        messageId: response.messageId,
        idempotencyKey,
      });

      return response.messageId;
    }

    // Development fallback: direct fetch
    if (process.env.NODE_ENV !== "production") {
      logger.warn("QStash not configured, using direct fetch (dev only)", {
        task,
      });

      const response = await fetch(dispatchUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ task, payload }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`Dispatch failed: ${response.status}`);
      }

      logger.info("Task dispatched via direct fetch (dev)", { task });
      return null;
    }

    // Production: QStash is required
    throw new Error(
      "QStash is required for production dispatch reliability. " +
        "Set QSTASH_TOKEN environment variable.",
    );
  } catch (error) {
    logger.error("Failed to dispatch task", {
      task,
      error: error instanceof Error ? error.message : String(error),
    });

    // Re-throw in production to fail the request
    if (process.env.NODE_ENV === "production") {
      throw error;
    }

    // In development, log but don't fail
    return null;
  }
}
