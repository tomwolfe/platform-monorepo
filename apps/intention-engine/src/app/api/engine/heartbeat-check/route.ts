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

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  withQStashAuth,
  formatError,
  formatSuccess,
  Logger,
  ServiceUnavailableError,
  ExecutionError,
} from "@repo/shared";
import { createHeartbeatService } from "@repo/shared";

const logger = new Logger({ serviceName: "heartbeat-check" });

const HeartbeatRequestSchema = z.object({
  executionId: z.string().uuid(),
  expectedStepIndex: z.number().int().nonnegative(),
});

type HeartbeatRequestType = z.infer<typeof HeartbeatRequestSchema>;

async function heartbeatCheckHandler(
  request: NextRequest,
  body: HeartbeatRequestType,
): Promise<NextResponse> {
  const { executionId, expectedStepIndex } = body;

  try {
    logger.info(
      `Received heartbeat check for ${executionId} (expected step: ${expectedStepIndex})`,
    );

    // Create heartbeat service
    const heartbeatService = createHeartbeatService();

    // Check if saga is stuck
    const checkResult = await heartbeatService.checkHeartbeat(
      executionId,
      expectedStepIndex,
    );

    logger.info(
      `Check result for ${executionId}: ${JSON.stringify(checkResult)}`,
    );

    // Take action based on result
    if (checkResult.action === "none") {
      // Saga progressed normally
      return NextResponse.json(
        formatSuccess({
          action: "none",
          message: checkResult.reason,
          executionId,
        }),
      );
    }

    if (checkResult.action === "resume") {
      // Attempt automatic recovery
      const recoveryResult = await heartbeatService.executeRecovery(
        executionId,
        expectedStepIndex,
      );

      if (recoveryResult.success) {
        return NextResponse.json(
          formatSuccess({
            action: "resume",
            message: `Recovery initiated: resuming at step ${expectedStepIndex}`,
            executionId,
            recoveryAttempted: true,
          }),
        );
      } else {
        // Recovery failed - escalate
        const heartbeat = await heartbeatService.getHeartbeat(executionId);
        await heartbeatService.escalateToHuman(executionId, {
          currentStepIndex: checkResult.currentStepIndex || 0,
          expectedStepIndex,
          recoveryAttempts: heartbeat?.recoveryAttempts || 0,
          lastKnownState: heartbeat?.lastKnownState,
        });

        const errorResponse = formatError(
          new ExecutionError(`Recovery failed: ${recoveryResult.error}`, {
            executionId,
            expectedStepIndex,
          }),
          "EXECUTION_FAILED",
        );
        return NextResponse.json(errorResponse, { status: 500 });
      }
    }

    if (checkResult.action === "escalate") {
      // Max recovery attempts exceeded
      const heartbeat = await heartbeatService.getHeartbeat(executionId);
      await heartbeatService.escalateToHuman(executionId, {
        currentStepIndex: checkResult.currentStepIndex || 0,
        expectedStepIndex,
        recoveryAttempts: heartbeat?.recoveryAttempts || 0,
        lastKnownState: heartbeat?.lastKnownState,
      });

      const errorResponse = formatError(
        new ServiceUnavailableError(
          "Max recovery attempts exceeded - manual intervention required",
          { executionId, expectedStepIndex },
        ),
        "SERVICE_UNAVAILABLE",
      );
      return NextResponse.json(errorResponse, { status: 500 });
    }

    // Fallback response
    return NextResponse.json(
      formatSuccess({
        action: checkResult.action,
        message: checkResult.reason,
        executionId,
      }),
    );
  } catch (error) {
    logger.error("Error processing heartbeat", { error: String(error) });
    const errorResponse = formatError(error, "EXECUTION_FAILED");
    return NextResponse.json(errorResponse, { status: 500 });
  }
}

export const POST = withQStashAuth(heartbeatCheckHandler);

/**
 * GET endpoint for health check
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    service: "heartbeat-check",
    timestamp: new Date().toISOString(),
  });
}
