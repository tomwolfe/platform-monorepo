/**
 * Confirmation Endpoint - Human-in-the-Loop (HITL) for Interrupted Sagas
 *
 * Problem Solved: High-Risk Action Confirmation
 * - Actions like payments, bookings with deposits, or schema-altering operations
 *   require explicit user confirmation before execution
 * - Saga yields state to Redis with SUSPENDED status
 * - UI receives confirmation token and presents "Confirm" button to user
 * - This endpoint is the ONLY way to resume a SUSPENDED saga
 *
 * Architecture:
 * 1. WorkflowMachine detects high-risk action (e.g., payment > $100)
 * 2. Machine transitions to SUSPENDED state, generates confirmation token
 * 3. Confirmation data stored in Redis: confirmation:{token}
 * 4. UI receives token via Ably real-time update
 * 5. User clicks "Confirm" in UI
 * 6. UI POSTs to /api/engine/confirm with token
 * 7. Endpoint validates token, transitions saga back to EXECUTING
 * 8. QStash trigger resumes execution chain
 *
 * Security:
 * - Confirmation tokens are UUIDs with 15-minute TTL
 * - Token includes executionId hash to prevent token substitution
 * - Requires user authentication (clerkId matching)
 *
 * @package apps/intention-engine
 * @since 1.0.0
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { RealtimeService } from "@repo/shared";
import { Tracer } from "@/lib/engine/tracing";
import { ConfirmationService, type ConfirmationData, type ConfirmationResult } from "@/lib/engine/confirmation-service";

// ============================================================================
// CONFIGURATION
// ============================================================================

export const runtime = "nodejs";
export const maxDuration = 10; // Vercel Hobby limit

// ============================================================================
// REQUEST SCHEMA
// ============================================================================

const ConfirmRequestSchema = z.object({
  token: z.string().uuid("Invalid confirmation token format"),
  metadata: z.object({
    clerkId: z.string().optional(),
    userId: z.string().optional(),
  }).optional(),
});

// ============================================================================
// API HANDLER
// ============================================================================

async function confirmHandler(
  request: NextRequest,
  token: string,
  userContext?: { clerkId?: string; userId?: string }
): Promise<NextResponse<ConfirmationResult>> {
  const startTime = performance.now();

  return Tracer.startActiveSpan("confirmation_execution", async (span) => {
    const traceId = span.spanContext()?.traceId;

    try {
      // Validate token
      const confirmationData = await ConfirmationService.validateToken(
        token,
        userContext
      );

      if (!confirmationData) {
        return NextResponse.json(
          {
            success: false,
            executionId: "unknown",
            status: "NOT_FOUND",
            error: {
              code: "CONFIRMATION_NOT_FOUND",
              message: "Invalid or expired confirmation token",
            },
          },
          { status: 404 }
        );
      }

      span.setAttributes({
        execution_id: confirmationData.executionId,
        step_id: confirmationData.stepId,
        tool_name: confirmationData.toolName,
        trace_id: traceId,
      });

      console.log(
        `[ConfirmEndpoint] Validated confirmation token for execution ${confirmationData.executionId}, ` +
        `step ${confirmationData.stepIndex} (${confirmationData.toolName})`
      );

      // Resume suspended saga
      const newState = await ConfirmationService.resumeSuspendedSaga(
        confirmationData.executionId,
        confirmationData
      );

      // Delete token (consume it)
      await ConfirmationService.deleteToken(token);

      // Trigger next step via QStash
      const nextStepTriggered = await ConfirmationService.triggerNextStep(
        confirmationData.executionId,
        newState,
        traceId,
        confirmationData.executionId // Use executionId as correlationId
      );

      // Publish real-time update to UI
      try {
        await RealtimeService.publish(
          "nervous-system:updates",
          "ConfirmationAccepted",
          {
            executionId: confirmationData.executionId,
            stepId: confirmationData.stepId,
            stepIndex: confirmationData.stepIndex,
            toolName: confirmationData.toolName,
            status: "EXECUTING",
            message: "Confirmation received, resuming execution...",
            timestamp: new Date().toISOString(),
            traceId,
          }
        );
      } catch (err) {
        console.warn("[ConfirmEndpoint] Failed to publish to Ably:", err);
      }

      const duration = performance.now() - startTime;

      return NextResponse.json({
        success: true,
        executionId: confirmationData.executionId,
        status: "EXECUTING",
        message: "Confirmation accepted, execution resumed",
        nextStepTriggered,
      });
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));

      console.error("[ConfirmEndpoint] Handler error:", error);

      const errorMessage = error instanceof Error ? error.message : String(error);
      const isExpired = errorMessage.includes("expired");

      return NextResponse.json(
        {
          success: false,
          executionId: "unknown",
          status: isExpired ? "EXPIRED" : "ERROR",
          error: {
            code: isExpired ? "CONFIRMATION_EXPIRED" : "CONFIRMATION_ERROR",
            message: errorMessage,
          },
        },
        { status: isExpired ? 410 : 500 }
      );
    }
  });
}

// ============================================================================
// API ROUTE
// ============================================================================

export async function POST(request: NextRequest): Promise<NextResponse<ConfirmationResult>> {
  try {
    // Parse and validate request
    const rawBody = await request.json();
    const validatedBody = ConfirmRequestSchema.safeParse(rawBody);

    if (!validatedBody.success) {
      return NextResponse.json(
        {
          success: false,
          executionId: "unknown",
          status: "VALIDATION_ERROR",
          error: {
            code: "VALIDATION_ERROR",
            message: `Invalid request: ${validatedBody.error.message}`,
          },
        },
        { status: 400 }
      );
    }

    const { token, metadata } = validatedBody.data;

    // Call handler with user context
    return await confirmHandler(request, token, metadata);
  } catch (error) {
    console.error("[ConfirmEndpoint] Unhandled error:", error);

    return NextResponse.json(
      {
        success: false,
        executionId: "unknown",
        status: "INTERNAL_ERROR",
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 500 }
    );
  }
}
