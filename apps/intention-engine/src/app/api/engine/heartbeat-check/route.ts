/**
 * Heartbeat Check API Route
 *
 * Webhook handler for QStash-triggered heartbeat checks.
 * Verifies if a yielded saga is stuck and triggers automatic recovery.
 *
 * Flow:
 * 1. QStash triggers this endpoint after 30s delay
 * 2. Check if saga progressed beyond expected step
 * 3. If stuck, attempt automatic recovery
 * 4. If max attempts exceeded, escalate to human
 *
 * @see packages/shared/src/services/heartbeat.ts
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withQStashAuth } from '@repo/shared';
import { createHeartbeatService } from '@repo/shared';

const HeartbeatRequestSchema = z.object({
  executionId: z.string().uuid(),
  expectedStepIndex: z.number().int().nonnegative(),
});

async function heartbeatCheckHandler(
  request: NextRequest,
  body: z.infer<typeof HeartbeatRequestSchema>
): Promise<NextResponse> {
  const startTime = Date.now();
  const { executionId, expectedStepIndex } = body;

  try {
    console.log(
      `[HeartbeatCheck] Received heartbeat check for ${executionId} (expected step: ${expectedStepIndex})`
    );

    // Create heartbeat service
    const heartbeatService = createHeartbeatService();

    // Check if saga is stuck
    const checkResult = await heartbeatService.checkHeartbeat(
      executionId,
      expectedStepIndex
    );

    console.log(
      `[HeartbeatCheck] Check result for ${executionId}:`,
      JSON.stringify(checkResult, null, 2)
    );

    // Take action based on result
    if (checkResult.action === 'none') {
      // Saga progressed normally
      return NextResponse.json({
        success: true,
        action: 'none',
        message: checkResult.reason,
        executionId,
      });
    }

    if (checkResult.action === 'resume') {
      // Attempt automatic recovery
      const recoveryResult = await heartbeatService.executeRecovery(
        executionId,
        expectedStepIndex
      );

      if (recoveryResult.success) {
        return NextResponse.json({
          success: true,
          action: 'resume',
          message: `Recovery initiated: resuming at step ${expectedStepIndex}`,
          executionId,
          recoveryAttempted: true,
        });
      } else {
        // Recovery failed - escalate
        const heartbeat = await heartbeatService.getHeartbeat(executionId);
        await heartbeatService.escalateToHuman(executionId, {
          currentStepIndex: checkResult.currentStepIndex || 0,
          expectedStepIndex,
          recoveryAttempts: heartbeat?.recoveryAttempts || 0,
          lastKnownState: heartbeat?.lastKnownState,
        });

        return NextResponse.json({
          success: false,
          action: 'escalate',
          message: `Recovery failed: ${recoveryResult.error}`,
          executionId,
          escalated: true,
        }, { status: 500 });
      }
    }

    if (checkResult.action === 'escalate') {
      // Max recovery attempts exceeded
      const heartbeat = await heartbeatService.getHeartbeat(executionId);
      await heartbeatService.escalateToHuman(executionId, {
        currentStepIndex: checkResult.currentStepIndex || 0,
        expectedStepIndex,
        recoveryAttempts: heartbeat?.recoveryAttempts || 0,
        lastKnownState: heartbeat?.lastKnownState,
      });

      return NextResponse.json({
        success: false,
        action: 'escalate',
        message: 'Max recovery attempts exceeded - manual intervention required',
        executionId,
        escalated: true,
      }, { status: 500 });
    }

    // Fallback response
    return NextResponse.json({
      success: true,
      action: checkResult.action,
      message: checkResult.reason,
      executionId,
    });

  } catch (error) {
    console.error('[HeartbeatCheck] Error processing heartbeat:', error);

    return NextResponse.json(
      {
        error: 'Internal server error',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

export const POST = withQStashAuth(heartbeatCheckHandler);

/**
 * GET endpoint for health check
 */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'heartbeat-check',
    timestamp: new Date().toISOString(),
  });
}
