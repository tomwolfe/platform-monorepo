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
 * - Requires x-internal-system-key header for auth
 * - QStash webhook verification in production
 *
 * @package apps/intention-engine
 * @since 1.0.0
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getOutboxService } from '@repo/shared';
import { QStashService, verifyQStashWebhook } from '@repo/shared';
import { redis } from '@/lib/redis-client';

// ============================================================================
// CONFIGURATION
// ============================================================================

const INTERNAL_SYSTEM_KEY =
  process.env.INTERNAL_SYSTEM_KEY || 'internal-system-key-change-in-production';

export const runtime = 'nodejs';
export const maxDuration = 10; // Vercel Hobby limit

// ============================================================================
// REQUEST SCHEMA
// ============================================================================

const OutboxRelayRequestSchema = z.object({
  executionId: z.string().uuid(),
  timestamp: z.string().datetime().optional(),
});

// ============================================================================
// API HANDLER
// ============================================================================

async function outboxRelayHandler(
  request: NextRequest,
  executionId: string
): Promise<NextResponse> {
  const startTime = performance.now();

  try {
    console.log(`[OutboxRelay] Processing outbox for execution ${executionId}`);

    // Get outbox service
    const outboxService = getOutboxService(redis);

    // Process pending events for this execution
    // Note: In production, you might want to query by executionId specifically
    // For now, we process all pending events (batch processing)
    const processedCount = await outboxService.processPendingEvents(20);

    console.log(
      `[OutboxRelay] Processed ${processedCount} pending outbox events for execution ${executionId}`
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
    console.error('[OutboxRelay] Handler error:', error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // QSTASH WEBHOOK VERIFICATION
    const headers = request.headers;
    const upstashSignature = headers.get('upstash-signature');
    const upstashKeyId = headers.get('upstash-key-id');

    const isQStashWebhook = upstashSignature !== null;
    const isProduction = process.env.NODE_ENV === 'production';
    const hasSigningKey = !!process.env.QSTASH_CURRENT_SIGNING_KEY;

    if (isQStashWebhook) {
      // Webhook signature present - verify it
      if (isProduction && !hasSigningKey) {
        console.warn(
          '[OutboxRelay] QStash webhook received but QSTASH_CURRENT_SIGNING_KEY not configured'
        );
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'WEBHOOK_NOT_CONFIGURED',
              message: 'Webhook verification not configured. Set QSTASH_CURRENT_SIGNING_KEY.',
            },
          },
          { status: 500 }
        );
      }

      // In development without signing keys, skip verification
      if (!isProduction || !hasSigningKey) {
        console.warn('[OutboxRelay] QStash webhook verification skipped (dev mode)');
        const rawBody = await request.json();
        const validatedBody = OutboxRelayRequestSchema.safeParse(rawBody);

        if (!validatedBody.success) {
          return NextResponse.json(
            {
              success: false,
              error: {
                code: 'VALIDATION_ERROR',
                message: `Invalid request: ${validatedBody.error.message}`,
              },
            },
            { status: 400 }
          );
        }

        return await outboxRelayHandler(request, validatedBody.data.executionId);
      }

      // Production with signing key - verify signature
      const rawBody = await request.text();
      const isValid = await verifyQStashWebhook(rawBody, upstashSignature, upstashKeyId);

      if (!isValid) {
        console.warn('[OutboxRelay] QStash webhook signature verification failed');
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'UNAUTHORIZED',
              message: 'Invalid QStash signature',
            },
          },
          { status: 401 }
        );
      }

      const validatedBody = OutboxRelayRequestSchema.safeParse(JSON.parse(rawBody));

      if (!validatedBody.success) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: `Invalid request: ${validatedBody.error.message}`,
            },
          },
          { status: 400 }
        );
      }

      return await outboxRelayHandler(request, validatedBody.data.executionId);
    }

    // No webhook signature - direct API call
    // Check internal system key
    const internalKey = request.headers.get('x-internal-system-key');

    if (internalKey !== INTERNAL_SYSTEM_KEY) {
      console.warn(`[OutboxRelay] Invalid or missing internal system key`);
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or missing internal system key',
          },
        },
        { status: 401 }
      );
    }

    // Parse and validate request
    const rawBody = await request.json();
    const validatedBody = OutboxRelayRequestSchema.safeParse(rawBody);

    if (!validatedBody.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `Invalid request: ${validatedBody.error.message}`,
          },
        },
        { status: 400 }
      );
    }

    return await outboxRelayHandler(request, validatedBody.data.executionId);
  } catch (error) {
    console.error('[OutboxRelay] Unhandled error:', error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 500 }
    );
  }
}
