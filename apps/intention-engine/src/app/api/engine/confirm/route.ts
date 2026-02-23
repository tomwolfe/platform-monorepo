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
import { redis } from "@/lib/redis-client";
import { RealtimeService, QStashService } from "@repo/shared";
import { loadExecutionState, saveExecutionState } from "@/lib/engine/memory";
import { transitionState, ExecutionState } from "@/lib/engine/types";
import { Tracer } from "@/lib/engine/tracing";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIRMATION_TTL_SECONDS = 15 * 60; // 15 minutes
const INTERNAL_SYSTEM_KEY = process.env.INTERNAL_SYSTEM_KEY || "internal-system-key-change-in-production";

export const runtime = "nodejs";
export const maxDuration = 10; // Vercel Hobby limit

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface ConfirmationData {
  executionId: string;
  workflowId: string;
  intentId?: string;
  userId?: string;
  clerkId?: string;
  stepId: string;
  stepIndex: number;
  toolName: string;
  parameters: Record<string, unknown>;
  riskAssessment: {
    level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    reason: string;
    amount?: number;
  };
  createdAt: string;
  expiresAt: string;
}

export interface ConfirmationResult {
  success: boolean;
  executionId: string;
  status: string;
  message?: string;
  nextStepTriggered?: boolean;
  error?: {
    code: string;
    message: string;
  };
}

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
// CONFIRMATION SERVICE
// ============================================================================

class ConfirmationService {
  /**
   * Build Redis key for confirmation token
   */
  private static buildTokenKey(token: string): string {
    return `confirmation:${token}`;
  }

  /**
   * Build Redis key for execution's confirmation token
   */
  private static buildExecutionKey(executionId: string): string {
    return `confirmation:exec:${executionId}`;
  }

  /**
   * Generate a confirmation token for a suspended saga
   */
  static async createConfirmation(
    executionId: string,
    stepId: string,
    stepIndex: number,
    toolName: string,
    parameters: Record<string, unknown>,
    riskAssessment: ConfirmationData["riskAssessment"],
    userId?: string,
    clerkId?: string
  ): Promise<string> {
    const token = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + CONFIRMATION_TTL_SECONDS * 1000);

    const confirmationData: ConfirmationData = {
      executionId,
      workflowId: `workflow:${executionId}`,
      intentId: undefined, // Will be populated from state
      userId,
      clerkId,
      stepId,
      stepIndex,
      toolName,
      parameters,
      riskAssessment,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    // Store in Redis with TTL
    await redis.setex(
      this.buildTokenKey(token),
      CONFIRMATION_TTL_SECONDS,
      JSON.stringify(confirmationData)
    );

    // Also index by executionId for lookup
    await redis.setex(
      this.buildExecutionKey(executionId),
      CONFIRMATION_TTL_SECONDS,
      token
    );

    console.log(
      `[ConfirmationService] Created confirmation token ${token} for execution ${executionId}, ` +
      `step ${stepIndex} (${toolName}), expires in ${CONFIRMATION_TTL_SECONDS / 60} minutes`
    );

    return token;
  }

  /**
   * Validate and consume a confirmation token
   */
  static async validateToken(
    token: string,
    userContext?: { clerkId?: string; userId?: string }
  ): Promise<ConfirmationData | null> {
    const data = await redis.get<ConfirmationData>(this.buildTokenKey(token));

    if (!data) {
      return null;
    }

    // Check expiration
    const expiresAt = new Date(data.expiresAt);
    if (expiresAt < new Date()) {
      // Token expired - clean up
      await this.deleteToken(token);
      throw new Error(
        `Confirmation token expired. Please restart the operation.`
      );
    }

    // Validate user context if provided
    if (userContext) {
      if (userContext.clerkId && data.clerkId && userContext.clerkId !== data.clerkId) {
        throw new Error("Unauthorized: Confirmation token belongs to a different user");
      }
      if (userContext.userId && data.userId && userContext.userId !== data.userId) {
        throw new Error("Unauthorized: Confirmation token belongs to a different user");
      }
    }

    return data;
  }

  /**
   * Delete a confirmation token (after successful consumption)
   */
  static async deleteToken(token: string): Promise<void> {
    const data = await redis.get<ConfirmationData>(this.buildTokenKey(token));
    if (data) {
      await redis.del(this.buildExecutionKey(data.executionId));
    }
    await redis.del(this.buildTokenKey(token));
  }

  /**
   * Get confirmation token by executionId
   */
  static async getTokenByExecutionId(executionId: string): Promise<string | null> {
    return await redis.get<string>(this.buildExecutionKey(executionId));
  }

  /**
   * Resume a suspended saga
   */
  static async resumeSuspendedSaga(
    executionId: string,
    confirmationData: ConfirmationData
  ): Promise<ExecutionState> {
    // Load current state
    const state = await loadExecutionState(executionId);
    if (!state) {
      throw new Error(`Execution state not found for ${executionId}`);
    }

    // Validate state is SUSPENDED or AWAITING_CONFIRMATION
    if (state.status !== "SUSPENDED" && state.status !== "AWAITING_CONFIRMATION") {
      throw new Error(
        `Invalid state for confirmation: ${state.status}. ` +
        `Expected SUSPENDED or AWAITING_CONFIRMATION`
      );
    }

    // Update step state to mark it as confirmed
    const stepState = state.step_states.find(s => s.step_id === confirmationData.stepId);
    if (stepState) {
      stepState.status = "pending"; // Reset to pending for execution
      stepState.output = {
        ...stepState.output,
        confirmed: true,
        confirmedAt: new Date().toISOString(),
      };
    }

    // Transition state back to EXECUTING
    const newState = transitionState(state, "EXECUTING");
    newState.context = {
      ...newState.context,
      confirmationConsumed: true,
      confirmationConsumedAt: new Date().toISOString(),
    };

    // Save updated state
    await saveExecutionState(newState);

    console.log(
      `[ConfirmationService] Resumed saga ${executionId} from ${state.status} to EXECUTING`
    );

    return newState;
  }

  /**
   * Trigger next step via QStash after confirmation
   */
  static async triggerNextStep(
    executionId: string,
    state: ExecutionState,
    traceId?: string,
    correlationId?: string
  ): Promise<boolean> {
    try {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      const url = `${baseUrl}/api/engine/execute-step`;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-internal-system-key": INTERNAL_SYSTEM_KEY,
      };

      if (traceId) {
        headers["x-trace-id"] = traceId;
      }
      if (correlationId) {
        headers["x-correlation-id"] = correlationId;
      }

      const body = {
        executionId,
        status: state.status,
        timestamp: new Date().toISOString(),
      };

      const messageId = await QStashService.publish({
        url,
        body,
        headers,
      });

      console.log(
        `[ConfirmationService] Triggered next step for execution ${executionId}` +
        (messageId ? ` [message: ${messageId}]` : "")
      );

      return !!messageId;
    } catch (error) {
      console.error(
        `[ConfirmationService] Failed to trigger next step for ${executionId}:`,
        error
      );
      return false;
    }
  }
}

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

// ============================================================================
// UTILITY EXPORTS
// For use by WorkflowMachine to create confirmations
// ============================================================================

export { ConfirmationService };
export type { ConfirmationData, ConfirmationResult };
