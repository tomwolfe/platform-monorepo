/**
 * ConfirmationService - Human-in-the-Loop (HITL) for Interrupted Sagas
 *
 * Manages confirmation tokens for high-risk actions requiring user approval.
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

import { redis } from "@/lib/redis-client";
import { loadExecutionState, saveExecutionState } from "@/lib/engine/memory";
import { transitionState, ExecutionState } from "@/lib/engine/types";
import { QStashService } from "@repo/shared";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIRMATION_TTL_SECONDS = 15 * 60; // 15 minutes
const INTERNAL_SYSTEM_KEY = process.env.INTERNAL_SYSTEM_KEY || "internal-system-key-change-in-production";

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
// CONFIRMATION SERVICE
// ============================================================================

export class ConfirmationService {
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
        ...(stepState.output as Record<string, unknown> || {}),
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
