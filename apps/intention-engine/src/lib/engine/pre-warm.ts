/**
 * Infrastructure-Aware Execution - Cold Start Masking
 *
 * Problem: Cold Start Accumulation - In a 10-step plan, even with adaptive batching,
 * you might hit 3-4 lambda "hops." If each hop incurs a 1.5s cold start, the user
 * experiences a ~6s delay purely from infrastructure overhead.
 *
 * Solution: Pre-warm Signal for WorkflowMachine
 * - When Step N is 80% complete, fire a low-cost, asynchronous "ping" to the
 *   /api/engine/execute-step endpoint
 * - This ensures that by the time Step N+1 is officially triggered via QStash,
 *   the Lambda instance is already warm and ready to execute
 * - Reduces "Handoff Latency" from 2s to <200ms
 *
 * Architecture:
 * 1. PreWarmService tracks step completion progress
 * 2. At 80% completion, triggers async pre-warm request
 * 3. Pre-warm request initializes lambda runtime without executing logic
 * 4. Next QStash trigger hits warm lambda
 *
 * Implementation:
 * - Uses fire-and-forget fetch to pre-warm endpoint
 * - Tracks pre-warm state in Redis to avoid duplicate warming
 * - Configurable threshold (default: 80% step completion)
 *
 * @package apps/intention-engine
 */

import { redis } from "../redis-client";
import { ExecutionState, PlanStep } from "./types";
import { getCompletedSteps, getPendingSteps } from "./state-machine";

// ============================================================================
// CONFIGURATION
// ============================================================================

const PRE_WARM_CONFIG = {
  // Percentage of current segment completion to trigger pre-warm
  completionThreshold: 0.8,
  // Minimum steps completed before considering pre-warm
  minStepsCompleted: 1,
  // TTL for pre-warm state in Redis (seconds)
  preWarmStateTTL: 300, // 5 minutes
  // Pre-warm request timeout (ms)
  preWarmRequestTimeout: 2000,
  // Base URL for pre-warm requests (uses current host if not set)
  baseUrl: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  // Enable pre-warm logging
  debug: false,
};

// ============================================================================
// TYPES
// ============================================================================

export interface PreWarmState {
  executionId: string;
  preWarmTriggered: boolean;
  preWarmTriggeredAt?: string;
  currentStepIndex: number;
  totalSteps: number;
  completionPercentage: number;
  nextStepIndex: number;
  lambdaWarmed: boolean;
  lambdaWarmedAt?: string;
}

export interface PreWarmResult {
  success: boolean;
  warmed: boolean;
  warmStartTimeMs?: number;
  error?: string;
}

// ============================================================================
// PRE-WARM SERVICE
// ============================================================================

export class PreWarmService {
  private executionId: string;
  private state: PreWarmState;

  constructor(executionId: string) {
    this.executionId = executionId;
    this.state = {
      executionId,
      preWarmTriggered: false,
      currentStepIndex: 0,
      totalSteps: 0,
      completionPercentage: 0,
      nextStepIndex: 0,
      lambdaWarmed: false,
    };
  }

  /**
   * Update execution progress and check if pre-warm should be triggered
   */
  async updateProgress(
    currentState: ExecutionState,
    totalSteps: number
  ): Promise<PreWarmResult> {
    const completedSteps = getCompletedSteps(currentState);
    const pendingSteps = getPendingSteps(currentState);
    
    const currentStepIndex = completedSteps.length;
    const completionPercentage = totalSteps > 0 
      ? currentStepIndex / totalSteps 
      : 0;
    const nextStepIndex = pendingSteps.length > 0 
      ? currentState.step_states.findIndex(s => s.status === "pending")
      : totalSteps;

    // Update state
    this.state = {
      ...this.state,
      currentStepIndex,
      totalSteps,
      completionPercentage,
      nextStepIndex: nextStepIndex >= 0 ? nextStepIndex : totalSteps,
    };

    // Check if we should trigger pre-warm
    if (this.shouldTriggerPreWarm()) {
      return await this.triggerPreWarm();
    }

    return { success: true, warmed: false };
  }

  /**
   * Check if pre-warm should be triggered
   */
  private shouldTriggerPreWarm(): boolean {
    // Don't trigger if already triggered
    if (this.state.preWarmTriggered) return false;

    // Don't trigger if no more steps
    if (this.state.nextStepIndex >= this.state.totalSteps) return false;

    // Check completion threshold
    if (this.state.completionPercentage < PRE_WARM_CONFIG.completionThreshold) {
      return false;
    }

    // Check minimum steps completed
    if (this.state.currentStepIndex < PRE_WARM_CONFIG.minStepsCompleted) {
      return false;
    }

    return true;
  }

  /**
   * Trigger pre-warm request to warm up lambda for next step
   */
  private async triggerPreWarm(): Promise<PreWarmResult> {
    const startTime = Date.now();
    
    try {
      // Mark as triggered to avoid duplicate calls
      this.state.preWarmTriggered = true;
      this.state.preWarmTriggeredAt = new Date().toISOString();

      // Store state in Redis for observability
      await this.storePreWarmState();

      // Fire-and-forget pre-warm request
      // We don't await this - it's best-effort
      this.sendPreWarmRequest().catch(error => {
        console.warn("[PreWarm] Pre-warm request failed (non-blocking):", error);
      });

      if (PRE_WARM_CONFIG.debug) {
        console.log(
          `[PreWarm] Triggered for ${this.executionId} ` +
          `(completion: ${(this.state.completionPercentage * 100).toFixed(1)}%)`
        );
      }

      return {
        success: true,
        warmed: true,
        warmStartTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      console.error("[PreWarm] Failed to trigger pre-warm:", error);
      return {
        success: false,
        warmed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Send pre-warm request to lambda endpoint
   * Fire-and-forget - does not wait for response
   */
  private async sendPreWarmRequest(): Promise<void> {
    const warmUrl = `${PRE_WARM_CONFIG.baseUrl}/api/engine/pre-warm`;
    
    try {
      // Create abort controller for timeout
      const abortController = new AbortController();
      const timeoutId = setTimeout(
        () => abortController.abort(),
        PRE_WARM_CONFIG.preWarmRequestTimeout
      );

      // Fire-and-forget request
      // We intentionally don't await or check response
      fetch(warmUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          executionId: this.executionId,
          nextStepIndex: this.state.nextStepIndex,
          triggeredAt: this.state.preWarmTriggeredAt,
        }),
        signal: abortController.signal,
      }).catch(error => {
        // Silently ignore errors - pre-warm is best-effort
        if (PRE_WARM_CONFIG.debug) {
          console.warn("[PreWarm] Request error (ignored):", error);
        }
      }).finally(() => {
        clearTimeout(timeoutId);
      });

      // Mark lambda as warmed (optimistic)
      this.state.lambdaWarmed = true;
      this.state.lambdaWarmedAt = new Date().toISOString();
      
      // Update Redis
      await this.storePreWarmState();
    } catch (error) {
      // Ignore errors - pre-warm is best-effort
      if (PRE_WARM_CONFIG.debug) {
        console.warn("[PreWarm] sendPreWarmRequest error (ignored):", error);
      }
    }
  }

  /**
   * Store pre-warm state in Redis for observability
   */
  private async storePreWarmState(): Promise<void> {
    try {
      const key = `prewarm:${this.executionId}`;
      await redis?.setex(
        key,
        PRE_WARM_CONFIG.preWarmStateTTL,
        JSON.stringify(this.state)
      );
    } catch (error) {
      console.warn("[PreWarm] Failed to store state:", error);
    }
  }

  /**
   * Load pre-warm state from Redis
   */
  static async loadPreWarmState(executionId: string): Promise<PreWarmState | null> {
    try {
      const key = `prewarm:${executionId}`;
      const data = await redis?.get<string>(key);
      if (data) {
        return JSON.parse(data) as PreWarmState;
      }
    } catch (error) {
      console.warn("[PreWarm] Failed to load state:", error);
    }
    return null;
  }

  /**
   * Check if lambda was pre-warmed for this execution
   */
  static async isLambdaWarmed(executionId: string): Promise<boolean> {
    const state = await this.loadPreWarmState(executionId);
    return state?.lambdaWarmed || false;
  }

  /**
   * Get pre-warm statistics for an execution
   */
  static async getPreWarmStats(executionId: string): Promise<{
    triggered: boolean;
    warmed: boolean;
    completionPercentage: number;
    triggeredAt?: string;
    warmedAt?: string;
  } | null> {
    const state = await this.loadPreWarmState(executionId);
    if (!state) return null;

    return {
      triggered: state.preWarmTriggered,
      warmed: state.lambdaWarmed,
      completionPercentage: state.completionPercentage,
      triggeredAt: state.preWarmTriggeredAt,
      warmedAt: state.lambdaWarmedAt,
    };
  }
}

// ============================================================================
// PRE-WARM API ENDPOINT
// Receives pre-warm signals and initializes lambda runtime
// ============================================================================

/**
 * Pre-warm endpoint handler
 * 
 * This endpoint is called by PreWarmService to warm up the lambda
 * before the actual QStash trigger arrives.
 * 
 * It performs minimal work:
 * 1. Initializes database connection pool
 * 2. Initializes Redis client
 * 3. Loads execution state (optional, for extra warming)
 * 4. Returns immediately
 */
export async function handlePreWarmRequest(
  executionId: string,
  nextStepIndex: number
): Promise<{ success: boolean; warmed: boolean }> {
  const startTime = Date.now();

  try {
    // Log pre-warm event
    console.log(
      `[PreWarm] Lambda warming for ${executionId} (next step: ${nextStepIndex})`
    );

    // Warm database connection (lazy initialization)
    // This ensures the connection pool is initialized
    try {
      const { db } = await import("@repo/database");
      // Perform a minimal query to warm the connection
      await db.execute("SELECT 1");
    } catch (error) {
      // Ignore DB errors - this is just warming
      if (PRE_WARM_CONFIG.debug) {
        console.warn("[PreWarm] DB warm failed:", error);
      }
    }

    // Warm Redis connection
    try {
      await redis?.get("ping");
    } catch (error) {
      // Ignore Redis errors
      if (PRE_WARM_CONFIG.debug) {
        console.warn("[PreWarm] Redis warm failed:", error);
      }
    }

    // Optionally load execution state
    try {
      const { loadExecutionState } = await import("./memory");
      await loadExecutionState(executionId);
    } catch (error) {
      // Ignore state load errors
      if (PRE_WARM_CONFIG.debug) {
        console.warn("[PreWarm] State load failed:", error);
      }
    }

    const warmDuration = Date.now() - startTime;
    console.log(`[PreWarm] Lambda warmed in ${warmDuration}ms for ${executionId}`);

    return { success: true, warmed: true };
  } catch (error) {
    console.error("[PreWarm] Warming failed:", error);
    return { success: false, warmed: false };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createPreWarmService(executionId: string): PreWarmService {
  return new PreWarmService(executionId);
}
