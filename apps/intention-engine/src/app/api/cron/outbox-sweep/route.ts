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

import { NextRequest, NextResponse } from 'next/server';
import { withCronAuth, Logger } from '@repo/shared';
import { getOutboxListener } from '@repo/shared';

export const runtime = 'nodejs';
export const maxDuration = 30; // Vercel Hobby limit

const logger = new Logger({ serviceName: 'outbox-sweep-cron' });

async function cronHandler(req: NextRequest): Promise<NextResponse> {
  const startTime = performance.now();

  try {
    logger.info({ message: 'Starting outbox sweep' });

    const listener = getOutboxListener();
    await listener.pollAndProcess();

    const stats = listener.getStats();
    const duration = performance.now() - startTime;

    logger.info({
      message: 'Outbox sweep completed',
      durationMs: Math.round(duration),
      stats,
    });

    return NextResponse.json({
      success: true,
      message: 'Outbox sweep completed',
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
    logger.error({
      message: 'Outbox sweep failed',
      error: error instanceof Error ? error.message : String(error),
    });

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

// Wrap handler with cron authentication
export const GET = withCronAuth(cronHandler);
export const POST = withCronAuth(cronHandler);
