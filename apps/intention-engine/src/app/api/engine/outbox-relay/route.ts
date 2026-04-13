/**
 * Outbox Relay API - Self-Triggering Outbox Pattern
 *
 * This endpoint processes pending outbox events from Postgres and syncs them to Redis.
 * It is triggered automatically by QStash after DB transactions commit outbox events.
 *
 * Architecture:
 * 1. API route commits transaction with outbox event (status: 'pending')
 * 2. Fire-and-forget QStash trigger to this endpoint
 * 3. This endpoint processes pending events and updates Redis cache
 * 4. Updates outbox status to 'processed'
 *
 * Security:
 * - Zero-Trust: Requires Bearer JWT token for service-to-service auth
 * - QStash webhook verification via withQStashAuth wrapper
 *
 * @package apps/intention-engine
 * @since 1.0.0
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  withQStashAuth,
  withUnifiedApiHandler,
  getOutboxService,
  getRedisClient,
  ServiceNamespace,
  Logger,
} from "@repo/shared";

const redis = getRedisClient(ServiceNamespace.IE);
const logger = new Logger({ serviceName: "outbox-relay" });

// ============================================================================
// CONFIGURATION
// ============================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10; // Vercel Hobby limit

// ============================================================================
// REQUEST SCHEMA
// ============================================================================

const OutboxRelayRequestSchema = z.object({
  executionId: z.string().uuid(),
  timestamp: z.string().datetime().optional(),
});

// ============================================================================
// API HANDLER (wrapped with QStash auth)
// ============================================================================

async function outboxRelayHandler(
  request: NextRequest,
  body: z.infer<typeof OutboxRelayRequestSchema>,
): Promise<NextResponse> {
  const startTime = performance.now();
  const { executionId } = body;

  try {
    logger.info(`Processing outbox for execution ${executionId}`);

    // Get outbox service
    const outboxService = getOutboxService(redis);

    // Process pending events for this execution
    // Note: In production, you might want to query by executionId specifically
    // For now, we process all pending events (batch processing)
    const processedCount = await outboxService.processPendingEvents(20);

    logger.info(
      `Processed ${processedCount} pending outbox events for execution ${executionId}`,
    );

    const duration = performance.now() - startTime;

    return NextResponse.json({
      success: true,
      executionId,
      processedCount,
      duration: Math.round(duration),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Handler error", { error: String(error) });

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 500 },
    );
  }
}

export const POST = withQStashAuth(
  withUnifiedApiHandler(
    async (request: NextRequest) => {
      const body = await request.json();
      return outboxRelayHandler(
        request,
        body as { executionId: string; timestamp?: string },
      );
    },
    {
      serviceName: "outbox-relay",
    },
  ),
);
