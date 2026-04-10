import { NextRequest, NextResponse } from "next/server";
import {
  withCronAuth,
  Logger,
  getRedisClient,
  ServiceNamespace,
  createErrorResponse,
} from "@repo/shared";
import { QStashService } from "@repo/shared/services/qstash";

export const runtime = "nodejs";
export const maxDuration = 10; // Vercel Hobby limit

const logger = new Logger({ serviceName: "recover-stuck-sagas-cron" });

// ============================================================================
// CONSTANTS
// ============================================================================

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const MAX_RECOVERY_ATTEMPTS = 3; // Alert if exceeded
const SAGA_STATE_KEY_PREFIX = "saga:state";
const SAGA_COMPLETION_KEY_PREFIX = "saga:completion";

// ============================================================================
// ALERTING
// ============================================================================

/**
 * Send an alert webhook if stuck sagas exceed threshold.
 */
async function sendAlertWebhook(
  alertType: string,
  details: Record<string, unknown>,
): Promise<void> {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return; // No webhook configured

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alertType,
        service: "recover-stuck-sagas",
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

// ============================================================================
// TYPES
// ============================================================================

interface SagaState {
  executionId: string;
  workflowId?: string;
  status: string;
  currentStep?: number;
  totalSteps?: number;
  lastCompletedStep?: number;
  updatedAt: number; // Unix timestamp
  recoveryAttempts?: number;
}

interface SagaRecoveryResult {
  executionId: string;
  status: string;
  currentStep: number;
  lastCompletedStep?: number;
  recoveryAction: "recovered" | "alerted" | "skipped";
  reason?: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Scan Redis for saga state keys
 * Note: Uses SCAN pattern to avoid blocking on large keyspaces
 */
async function scanSagaStateKeys(pattern: string): Promise<string[]> {
  const redis = getRedisClient(ServiceNamespace.IE);
  const keys: string[] = [];

  let cursor = 0;
  do {
    const result = await redis.scan(cursor, {
      match: pattern,
      count: 100,
    });
    cursor = result[0];
    keys.push(...result[1]);
  } while (cursor !== 0);

  return keys;
}

/**
 * Check if a saga is stuck in EXECUTING state
 */
async function checkStuckSaga(
  key: string,
): Promise<{ executionId: string; state: SagaState; isStuck: boolean } | null> {
  const redis = getRedisClient(ServiceNamespace.IE);

  try {
    // Extract executionId from key: saga:state:{executionId}
    const parts = key.split(":");
    if (parts.length < 3) return null;

    const executionId = parts.slice(2).join(":");

    const stateJson = await redis.get(key);
    if (!stateJson) return null;

    const state = JSON.parse(stateJson as string) as SagaState;

    // Check if saga is in EXECUTING state and hasn't been updated recently
    const isExecuting =
      state.status === "EXECUTING" || state.status === "RUNNING";
    const isStale = Date.now() - state.updatedAt > STALE_THRESHOLD_MS;

    return {
      executionId,
      state,
      isStuck: isExecuting && isStale,
    };
  } catch (error) {
    logger.warn({
      message: "Failed to parse saga state",
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Attempt to recover a stuck saga by triggering the next step
 */
async function recoverStuckSaga(
  executionId: string,
  state: SagaState,
): Promise<SagaRecoveryResult> {
  const recoveryAttempts = state.recoveryAttempts || 0;

  // Check if we've exceeded max recovery attempts
  if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
    logger.error({
      message:
        "Stuck saga exceeded max recovery attempts - manual intervention required",
      executionId,
      currentStep: state.currentStep,
      lastCompletedStep: state.lastCompletedStep,
      recoveryAttempts,
    });

    return {
      executionId,
      status: state.status,
      currentStep: state.currentStep || 0,
      lastCompletedStep: state.lastCompletedStep,
      recoveryAction: "alerted",
      reason: `Exceeded max recovery attempts (${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS})`,
    };
  }

  try {
    // Determine the next step to execute
    const nextStep = (state.lastCompletedStep || 0) + 1;

    logger.info({
      message: "Attempting to recover stuck saga",
      executionId,
      currentStep: state.currentStep,
      nextStep,
      recoveryAttempts,
    });

    // Trigger QStash to resume the saga at the next step
    await QStashService.triggerNextStep({
      executionId,
      stepIndex: nextStep,
    });

    // Update recovery attempts counter
    const redis = getRedisClient(ServiceNamespace.IE);
    const key = `${SAGA_STATE_KEY_PREFIX}:${executionId}`;
    await redis.set(
      key,
      JSON.stringify({
        ...state,
        recoveryAttempts: recoveryAttempts + 1,
        updatedAt: Date.now(),
        status: "EXECUTING",
      }),
    );

    return {
      executionId,
      status: state.status,
      currentStep: state.currentStep || 0,
      lastCompletedStep: state.lastCompletedStep,
      recoveryAction: "recovered",
      reason: `Triggered next step ${nextStep}`,
    };
  } catch (error) {
    logger.error({
      message: "Failed to recover stuck saga",
      executionId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      executionId,
      status: state.status,
      currentStep: state.currentStep || 0,
      lastCompletedStep: state.lastCompletedStep,
      recoveryAction: "skipped",
      reason: `Recovery failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * Stuck Saga Recovery Cron Endpoint
 *
 * PROBLEM SOLVED:
 * - Sagas can get stuck in EXECUTING state if:
 *   - QStash message is lost (rare)
 *   - Lambda crashes after updating state but before triggering next step
 *   - Network timeout between Redis update and QStash trigger
 *
 * SOLUTION:
 * - Runs every 5 minutes via QStash
 * - Scans Redis for sagas in EXECUTING state with updatedAt > 10 minutes ago
 * - Attempts recovery by triggering the next step via QStash
 * - Alerts if recovery attempts exceed threshold (indicates persistent bug)
 *
 * SECURITY:
 * - Requires CRON_SECRET header for authentication
 *
 * Usage:
 * POST /api/cron/recover-stuck-sagas
 * Headers:
 *   Authorization: Bearer <CRON_SECRET>
 */
async function postHandler(req: NextRequest) {
  try {
    logger.info({ message: "Starting stuck saga recovery scan" });

    // Scan for saga state keys
    const keys = await scanSagaStateKeys(`${SAGA_STATE_KEY_PREFIX}:*`);

    if (keys.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No sagas found to check",
        scannedCount: 0,
        recoveredCount: 0,
        alertedCount: 0,
        timestamp: new Date().toISOString(),
      });
    }

    logger.info({
      message: "Scanning sagas for stuck state",
      totalSagas: keys.length,
    });

    const results: SagaRecoveryResult[] = [];
    let recoveredCount = 0;
    let alertedCount = 0;

    // Check each saga for stuck state
    for (const key of keys) {
      const sagaCheck = await checkStuckSaga(key);

      if (!sagaCheck || !sagaCheck.isStuck) {
        continue;
      }

      logger.warn({
        message: "Stuck saga detected",
        executionId: sagaCheck.executionId,
        status: sagaCheck.state.status,
        lastUpdateMsAgo: Date.now() - sagaCheck.state.updatedAt,
        currentStep: sagaCheck.state.currentStep,
      });

      // Attempt recovery
      const recoveryResult = await recoverStuckSaga(
        sagaCheck.executionId,
        sagaCheck.state,
      );

      results.push(recoveryResult);

      if (recoveryResult.recoveryAction === "recovered") {
        recoveredCount++;
      } else if (recoveryResult.recoveryAction === "alerted") {
        alertedCount++;
      }
    }

    logger.info({
      message: "Stuck saga recovery completed",
      scannedCount: keys.length,
      recoveredCount,
      alertedCount,
      totalStuckFound: results.length,
    });

    // Alert if stuck sagas exceed threshold
    const alertThreshold = parseInt(
      process.env.STUCK_SAGA_ALERT_THRESHOLD || "5",
    );
    if (results.length >= alertThreshold || alertedCount > 0) {
      await sendAlertWebhook("stuck_saga_threshold_exceeded", {
        scannedCount: keys.length,
        totalStuck: results.length,
        recoveredCount,
        alertedCount,
        alertThreshold,
      });
    }

    return NextResponse.json({
      success: true,
      message: `Recovery complete: ${recoveredCount} recovered, ${alertedCount} alerted`,
      scannedCount: keys.length,
      recoveredCount,
      alertedCount,
      totalStuckFound: results.length,
      results: results.slice(0, 50), // Cap results in response
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({
      message: "Stuck saga recovery cron failed",
      error: error instanceof Error ? error.message : String(error),
    });

    // Alert on complete failure
    await sendAlertWebhook("cron_job_failure", {
      service: "recover-stuck-sagas",
      error: error instanceof Error ? error.message : String(error),
    });

    return createErrorResponse(
      error instanceof Error ? error.message : "Unknown error occurred",
      500,
      "INTERNAL_ERROR",
    );
  }
}

async function getHandler(req: NextRequest) {
  return NextResponse.json({
    status: "ok",
    message: "Stuck saga recovery cron endpoint is healthy",
    endpoint: "/api/cron/recover-stuck-sagas",
  });
}

// Wrap handlers with cron authentication
export const POST = withCronAuth(async (req: NextRequest) => {
  return postHandler(req);
});

export const GET = withCronAuth(async (req: NextRequest) => {
  return getHandler(req);
});
