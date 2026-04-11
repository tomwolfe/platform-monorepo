export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { NotifyService } from "@tablestack/lib/notifications";
import {
  withUnifiedApiHandler,
  Logger,
  formatApiError,
  formatApiSuccess,
  getRedisClient,
  ServiceNamespace,
  withRetry,
} from "@repo/shared";
import { withServerlessTimeout } from "@repo/shared/middleware/serverless-timeout";

export const runtime = "nodejs";

const logger = new Logger({ serviceName: "dispatch-handler" });

/**
 * POST /api/cron/dispatch - Async Task Dispatch Endpoint
 *
 * This endpoint processes background tasks that were previously handled by
 * Next.js `after()` hooks, which are unreliable in Vercel serverless environments.
 *
 * ## Supported Task Types
 *
 * 1. **send_reservation_email** - Send reservation confirmation emails
 * 2. **invalidate_availability_cache** - Clear Redis and Next.js ISR cache
 * 3. **send_checkout_webhook** - Send webhook callbacks for checkout events
 *
 * ## Architecture
 *
 * ```mermaid
 * sequenceDiagram
 *   participant API as Reserve/Checkout API
 *   participant QStash as QStash Queue
 *   participant Dispatch as POST /api/cron/dispatch
 *   participant Email as Email Service
 *   participant Cache as Redis/Next.js Cache
 *
 *   API->>QStash: Publish task payload
 *   QStash-->>API: Message ID (immediate)
 *   QStash->>Dispatch: POST with payload (async)
 *   Dispatch->>Email: Send email / Invalidate cache
 *   Dispatch-->>QStash: 200 OK (success)
 * ```
 *
 * ## Security
 *
 * - Requires `Idempotency-Key` header to prevent duplicate processing
 * - QStash signs requests with webhook signature (verified automatically)
 * - Automatic retries with exponential backoff on failure
 *
 * ## Request Schema
 *
 * ```json
 * {
 *   "task": "send_reservation_email" | "invalidate_availability_cache" | "send_checkout_webhook",
 *   "payload": {
 *     // Task-specific payload (see implementation)
 *   },
 *   "idempotencyKey": "unique-key-per-task"
 * }
 * ```
 *
 * @throws 400 - Missing or invalid task type
 * @throws 409 - Duplicate task (idempotency key already processed)
 * @throws 500 - Task execution failed
 */
async function postHandler(req: NextRequest) {
  // Validate idempotency key
  const idempotencyKey = req.headers.get("idempotency-key");
  if (!idempotencyKey) {
    return NextResponse.json(
      formatApiError(
        new Error("Idempotency-Key header is required"),
        "VALIDATION_ERROR",
      ),
      { status: 400 },
    );
  }

  // Check for duplicate processing (simple Redis-based idempotency)
  const redis = getRedisClient(ServiceNamespace.TS);
  const idempotencyKeyStr = `dispatch:idempotency:${idempotencyKey}`;
  const isDuplicate = await redis.get(idempotencyKeyStr);

  if (isDuplicate) {
    return NextResponse.json(
      formatApiError(new Error("Task already processed"), "CONFLICT"),
      {
        status: 409,
        headers: { "x-idempotency-duplicate": "true" },
      },
    );
  }

  let body: {
    task?: string;
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      formatApiError(new Error("Invalid JSON body"), "VALIDATION_ERROR"),
      { status: 400 },
    );
  }

  const { task, payload } = body as {
    task: string;
    payload: Record<string, unknown>;
  };

  if (!task || !payload) {
    return NextResponse.json(
      formatApiError(
        new Error("Missing required fields: task, payload"),
        "VALIDATION_ERROR",
      ),
      { status: 400 },
    );
  }

  try {
    switch (task) {
      case "send_reservation_email": {
        const {
          reservationId,
          guestEmail,
          guestName,
          restaurantName,
          partySize,
          startTime,
          verificationToken,
          isShadow,
          ownerEmail,
          claimToken,
        } = payload;

        const origin = payload.origin || process.env.NEXT_PUBLIC_APP_URL;

        if (isShadow) {
          // Send claim invitation to shadow restaurant owner
          await NotifyService.sendClaimInvitation(
            ownerEmail,
            restaurantName,
            claimToken,
          );
          await NotifyService.notifyOwner(
            ownerEmail,
            {
              guestName,
              partySize,
              startTime,
            },
            true,
          );
        } else {
          // Send confirmation email to guest
          const verifyUrl = `${origin}/verify/${verificationToken}`;
          await NotifyService.sendNotification({
            to: guestEmail,
            subject: `Confirm your reservation at ${restaurantName}`,
            html: `<h1>Hello ${guestName},</h1><p>Please confirm your reservation for ${partySize} people.</p><p><a href="${verifyUrl}">Click here to confirm</a></p>`,
          });
        }

        logger.info("Reservation email sent successfully", {
          reservationId,
          guestEmail,
          isShadow,
        });
        break;
      }

      case "invalidate_availability_cache": {
        const { restaurantId } = payload;

        // Redis cache invalidation
        const pattern = `availability:${restaurantId}:*`;
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
          await redis.del(...keys);
          logger.info({
            message: `[T2.1] Invalidated ${keys.length} availability cache entries`,
            restaurantId,
          });
        }

        // Next.js ISR cache invalidation
        revalidateTag("availability");
        revalidateTag(`restaurant:${restaurantId}`);

        logger.info("Availability cache invalidated", {
          restaurantId,
          invalidatedKeys: keys.length,
        });
        break;
      }

      case "send_checkout_webhook": {
        const { webhookUrl, reservationId, txHash, status, message } = payload;

        await withRetry(
          async () => {
            const response = await fetch(webhookUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Webhook-Source": "table-stack-checkout",
                "X-Reservation-Id": reservationId,
              },
              body: JSON.stringify({
                success: true,
                reservationId,
                txHash,
                status,
                message,
                timestamp: new Date().toISOString(),
              }),
              signal: AbortSignal.timeout(10000),
            });

            if (!response.ok) {
              throw new Error(
                `Webhook returned ${response.status}: ${response.statusText}`,
              );
            }
          },
          {
            maxRetries: 2,
            initialDelay: 1000,
            maxDelay: 5000,
            shouldRetry: (error) => {
              return !error.message?.includes("returned 4");
            },
          },
        );

        logger.info("Checkout webhook sent successfully", {
          reservationId,
          webhookUrl,
        });
        break;
      }

      default:
        return NextResponse.json(
          formatApiError(
            new Error(`Unknown task type: ${task}`),
            "VALIDATION_ERROR",
          ),
          { status: 400 },
        );
    }

    // Mark idempotency key as processed (24h TTL)
    await redis.set(idempotencyKeyStr, "processed", { ex: 86400 });

    return NextResponse.json(
      formatApiSuccess({
        message: `Task '${task}' executed successfully`,
        taskId: idempotencyKey,
      }),
    );
  } catch (error) {
    // Don't mark as processed - allow retry
    logger.error("Task execution failed", {
      task,
      error: error instanceof Error ? error.message : String(error),
    });

    // Re-throw to trigger QStash retry
    throw error;
  }
}

export const POST = withServerlessTimeout(
  withUnifiedApiHandler(postHandler, {
    serviceName: "dispatch-handler",
    includeStackTrace: process.env.NODE_ENV !== "production",
  }),
  8000,
);
