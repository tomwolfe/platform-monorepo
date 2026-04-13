/**
 * Outbox Sweep Cron - Serverless-Safe Outbox Processing
 *
 * This endpoint replaces the deprecated setInterval-based polling mechanism
 * for outbox processing. It is triggered on a schedule by QStash to process
 * any pending outbox events that were not picked up by the LISTEN/NOTIFY
 * mechanism.
 *
 * Architecture:
 * 1. QStash triggers this endpoint on a schedule (e.g., every 1-5 minutes)
 * 2. This endpoint calls outboxListener.pollAndProcess() to process pending events
 * 3. Events are synced to Redis cache via OutboxService
 *
 * Security:
 * - Protected by withCronAuth middleware (requires CRON_SECRET bearer token)
 * - Only QStash or authorized services can trigger this endpoint
 *
 * @package apps/intention-engine
 * @since 1.0.0
 */

import { NextRequest, NextResponse } from "next/server";
import { withCronAuth, Logger, withDistributedLock } from "@repo/shared";
import { getOutboxListener } from "@repo/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10; // Vercel Hobby limit

const logger = new Logger({ serviceName: "outbox-sweep-cron" });

/**
 * Send an alert webhook if outbox sweep fails or backlog exceeds threshold.
 */
async function sendAlertWebhook(
  alertType: string,
  details: Record<string, unknown>,
): Promise<void> {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alertType,
        service: "outbox-sweep",
        environment: process.env.NODE_ENV,
        timestamp: new Date().toISOString(),
        ...details,
      }),
    });
  } catch (error) {
    logger.warn("Failed to send alert webhook", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function cronHandler(req: NextRequest): Promise<NextResponse> {
  const startTime = performance.now();

  try {
    logger.info("Starting outbox sweep");

    const listener = getOutboxListener();

    // Prevent duplicate processing when cron intervals overlap in serverless
    let skipped = false;
    try {
      await withDistributedLock("cron:outbox-sweep", 60, async () => {
        await listener.pollAndProcess();
      });
    } catch (lockError) {
      if (
        lockError instanceof Error &&
        lockError.message.includes("Failed to acquire distributed lock")
      ) {
        skipped = true;
        logger.info("Outbox sweep skipped — already running");
      } else {
        throw lockError;
      }
    }

    if (skipped) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: "Already running",
        timestamp: new Date().toISOString(),
      });
    }

    const stats = listener.getStats();
    const duration = performance.now() - startTime;

    logger.info("Outbox sweep completed", {
      durationMs: Math.round(duration),
      stats,
    });

    // Alert if failed events exceed threshold
    const failThreshold = parseInt(
      process.env.OUTBOX_FAIL_ALERT_THRESHOLD || "10",
    );
    if (stats.eventsFailed >= failThreshold) {
      await sendAlertWebhook("outbox_failure_threshold_exceeded", {
        eventsFailed: stats.eventsFailed,
        eventsProcessed: stats.eventsProcessed,
        notificationsReceived: stats.notificationsReceived,
        threshold: failThreshold,
      });
    }

    return NextResponse.json({
      success: true,
      message: "Outbox sweep completed",
      durationMs: Math.round(duration),
      stats: {
        notificationsReceived: stats.notificationsReceived,
        eventsProcessed: stats.eventsProcessed,
        eventsFailed: stats.eventsFailed,
        fallbackPolls: stats.fallbackPolls,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Outbox sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    await sendAlertWebhook("cron_job_failure", {
      service: "outbox-sweep",
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

// Wrap handler with cron authentication
export const GET = withCronAuth((...args: unknown[]) => {
  const req = args[0] as NextRequest;
  return cronHandler(req);
});
export const POST = withCronAuth((...args: unknown[]) => {
  const req = args[0] as NextRequest;
  return cronHandler(req);
});
