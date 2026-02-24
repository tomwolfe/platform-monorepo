/**
 * Dead Letter Queue (DLQ) Monitoring Service
 *
 * Implements reconciliation worker for detecting and recovering "Zombie Sagas" -
 * sagas that are stuck in incomplete states due to failed compensations or
 * missed continuation events.
 *
 * KEY FEATURE: Integrated Repair Agent for Self-Healing
 * - When a zombie saga is detected, the Repair Agent analyzes the failure
 * - Uses LLM-powered diagnosis to determine root cause
 * - Generates and validates fix payloads using Shadow Dry-Run
 * - Auto-repairs fixable sagas without human intervention
 * - Only escalates truly unfixable sagas to humans
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { Redis } from "@upstash/redis";
import { RealtimeService } from "../realtime";
import { createRepairAgent, type ZombieSaga as RepairZombieSaga, type RepairResult } from "./repair-agent";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface ZombieSaga {
  executionId: string;
  workflowId: string;
  intentId?: string;
  userId?: string;
  status: string;
  lastActivityAt: string;
  inactiveDurationMs: number;
  stepStates: Array<{
    step_id: string;
    status: string;
    error?: any;
  }>;
  compensationsRegistered?: Array<{
    stepId: string;
    compensationTool: string;
    parameters: Record<string, unknown>;
  }>;
  requiresHumanIntervention: boolean;
  recoveryAttempts: number;
}

export interface DLQStats {
  totalZombieSagas: number;
  autoRecovered: number;
  manualInterventionRequired: number;
  avgInactiveDurationMs: number;
  oldestZombieAgeMs: number;
  byStatus: Record<string, number>;
}

export interface ReconciliationResult {
  scanned: number;
  zombieSagasDetected: number;
  autoRecovered: number;
  autoRepaired?: number; // Number repaired by Repair Agent
  escalatedToHuman: number;
  errors: Array<{
    executionId: string;
    error: string;
  }>;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface DLQConfig {
  /** Minimum inactive duration before considering a saga as zombie (default: 5 minutes) */
  minInactiveDurationMs: number;
  /** Maximum recovery attempts before escalating to human (default: 3) */
  maxRecoveryAttempts: number;
  /** Batch size for scanning (default: 100) */
  scanBatchSize: number;
  /** Enable debug logging */
  debug: boolean;
}

const DEFAULT_CONFIG: DLQConfig = {
  minInactiveDurationMs: 5 * 60 * 1000, // 5 minutes
  maxRecoveryAttempts: 3,
  scanBatchSize: 100,
  debug: false,
};

// ============================================================================
// DLQ MONITORING SERVICE
// ============================================================================

export class DLQMonitoringService {
  private redis: Redis;
  private config: DLQConfig;

  constructor(redis: Redis, config?: Partial<DLQConfig>) {
    this.redis = redis;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Build Redis key for execution state
   */
  private buildExecutionKey(executionId: string): string {
    return `task:${executionId}`;
  }

  /**
   * Build Redis key for DLQ entry
   */
  private buildDLQKey(executionId: string): string {
    return `dlq:saga:${executionId}`;
  }

  /**
   * Build Redis key for DLQ index (sorted set by inactive duration)
   */
  private buildDLQIndexKey(): string {
    return "dlq:index";
  }

  /**
   * Scan for zombie sagas
   * 
   * A saga is considered "zombie" if:
   * - Status is EXECUTING, AWAITING_CONFIRMATION, or COMPENSATING
   * - No activity for > minInactiveDurationMs
   * - Has incomplete steps
   */
  async scanForZombieSagas(): Promise<ZombieSaga[]> {
    const now = Date.now();
    const zombieSagas: ZombieSaga[] = [];

    // Scan for all task keys
    let cursor = 0;
    const pattern = "task:*";

    do {
      const result = await this.redis.scan(cursor, {
        match: pattern,
        count: this.config.scanBatchSize,
      });

      cursor = parseInt(result[0] as string, 10);
      const keys = result[1] as string[];

      // Check each task for zombie status
      for (const key of keys) {
        try {
          const taskData = await this.redis.get<any>(key);
          if (!taskData || !taskData.context) continue;

          const executionId = key.replace("task:", "");
          const context = taskData.context;
          const executionState = context.execution_state;

          if (!executionState) continue;

          const status = executionState.status;
          const isTerminalStatus = ["COMPLETED", "FAILED", "TIMEOUT", "CANCELLED"].includes(status);

          // Skip terminal states
          if (isTerminalStatus) continue;

          // Check last activity
          const lastActivityAt = context.last_checkpoint_at || executionState.updated_at || executionState.created_at;
          if (!lastActivityAt) continue;

          const lastActivityTime = new Date(lastActivityAt).getTime();
          const inactiveDuration = now - lastActivityTime;

          // Check if inactive for too long
          if (inactiveDuration >= this.config.minInactiveDurationMs) {
            // This is a zombie saga
            const stepStates = executionState.step_states || [];
            const completedSteps = stepStates.filter((s: any) => s.status === "completed").length;
            const failedSteps = stepStates.filter((s: any) => s.status === "failed").length;
            const totalSteps = executionState.plan?.steps?.length || 0;

            // Check if there are incomplete steps
            const hasIncompleteSteps = completedSteps + failedSteps < totalSteps;

            if (hasIncompleteSteps || status === "COMPENSATING" || context.compensationStatus === "PARTIALLY_COMPENSATED") {
              // Get recovery attempts
              const dlqKey = this.buildDLQKey(executionId);
              const dlqData = await this.redis.get<any>(dlqKey);
              const recoveryAttempts = dlqData?.recoveryAttempts || 0;

              // Determine if human intervention is required
              const requiresHumanIntervention = 
                recoveryAttempts >= this.config.maxRecoveryAttempts ||
                context.requiresHumanIntervention === true ||
                context.compensationStatus === "PARTIALLY_COMPENSATED";

              zombieSagas.push({
                executionId,
                workflowId: context.workflow_id || `workflow:${executionId}`,
                intentId: context.intent_id,
                userId: executionState.intent?.userId,
                status,
                lastActivityAt,
                inactiveDurationMs: inactiveDuration,
                stepStates: stepStates.map((s: any) => ({
                  step_id: s.step_id,
                  status: s.status,
                  error: s.error,
                })),
                compensationsRegistered: context.compensations_registered,
                requiresHumanIntervention,
                recoveryAttempts,
              });
            }
          }
        } catch (error) {
          console.error(`[DLQ] Failed to check task ${key}:`, error);
        }
      }

      // Limit total results to prevent memory issues
      if (zombieSagas.length >= 1000) {
        break;
      }
    } while (cursor !== 0);

    // Sort by inactive duration (oldest first)
    zombieSagas.sort((a, b) => b.inactiveDurationMs - a.inactiveDurationMs);

    return zombieSagas;
  }

  /**
   * Attempt to recover a zombie saga
   *
   * SELF-HEALING: Uses Repair Agent for intelligent recovery
   *
   * Recovery strategies:
   * 1. Repair Agent analyzes failure using LLM-powered diagnosis
   * 2. If fixable, generates and validates fix payload (Shadow Dry-Run)
   * 3. Auto-repairs if validation passes
   * 4. Falls back to simple resume for non-failed sagas
   * 5. Escalates to human if repair fails or is unsafe
   *
   * @param zombie - Zombie saga to recover
   * @returns Recovery result with action taken
   */
  async recoverZombieSaga(zombie: ZombieSaga): Promise<{
    success: boolean;
    action: "AUTO_REPAIRED" | "RESUMED" | "COMPENSATION_RETRIED" | "ESCALATED" | "SKIPPED";
    message?: string;
    repairResult?: RepairResult;
  }> {
    try {
      // Check if already escalated
      if (zombie.requiresHumanIntervention) {
        await this.escalateToHuman(zombie);
        return {
          success: false,
          action: "ESCALATED",
          message: "Escalated to human due to exhausted recovery attempts",
        };
      }

      // SELF-HEALING: Use Repair Agent for failed sagas
      if (zombie.stepStates.some(s => s.status === "failed")) {
        console.log(
          `[DLQ] Invoking Repair Agent for failed saga ${zombie.executionId}`
        );

        const repairAgent = createRepairAgent({
          redis: this.redis,
          maxAutoRepairAttempts: this.config.maxRecoveryAttempts,
          debug: this.config.debug,
        });

        // Convert ZombieSaga to RepairAgent's ZombieSaga format
        const repairZombie: RepairZombieSaga = {
          executionId: zombie.executionId,
          workflowId: zombie.workflowId,
          intentId: zombie.intentId,
          userId: zombie.userId,
          status: zombie.status,
          lastActivityAt: zombie.lastActivityAt,
          inactiveDurationMs: zombie.inactiveDurationMs,
          stepStates: zombie.stepStates,
          compensationsRegistered: zombie.compensationsRegistered,
          requiresHumanIntervention: zombie.requiresHumanIntervention,
          recoveryAttempts: zombie.recoveryAttempts,
          failureContext: zombie.stepStates.find(s => s.status === "failed")?.error,
        };

        // Attempt repair
        const repairResult = await repairAgent.analyzeAndRepair(repairZombie);

        if (repairResult.success && repairResult.action === "AUTO_REPAIRED") {
          console.log(
            `[DLQ] ✅ Auto-repaired saga ${zombie.executionId} ` +
            `(${repairResult.repairAnalysis?.failureType}, ` +
            `confidence: ${(repairResult.repairAnalysis?.confidence || 0).toFixed(2)})`
          );

          return {
            success: true,
            action: "AUTO_REPAIRED",
            message: `Auto-repaired: ${repairResult.repairAnalysis?.rootCause}`,
            repairResult,
          };
        }

        // Repair failed or was escalated
        if (repairResult.action === "ESCALATED") {
          console.log(
            `[DLQ] ⚠️ Repair Agent escalated saga ${zombie.executionId}: ` +
            repairResult.escalationReason
          );

          await this.escalateToHuman(
            zombie,
            repairResult.escalationReason || "Repair Agent could not safely fix"
          );

          return {
            success: false,
            action: "ESCALATED",
            message: repairResult.escalationReason,
            repairResult,
          };
        }

        // Repair attempted but didn't auto-repair (e.g., dry-run failed)
        console.log(
          `[DLQ] ⚠️ Repair Agent couldn't auto-repair ${zombie.executionId}, ` +
          `falling back to standard recovery`
        );
      }

      // Increment recovery attempts for standard recovery
      const dlqKey = this.buildDLQKey(zombie.executionId);
      const recoveryAttempts = zombie.recoveryAttempts + 1;
      await this.redis.setex(dlqKey, 86400 * 7, {
        executionId: zombie.executionId,
        workflowId: zombie.workflowId,
        detectedAt: new Date().toISOString(),
        recoveryAttempts,
        lastRecoveryAttempt: new Date().toISOString(),
        status: zombie.status,
        reason: "ZOMBIE_RECOVERY",
      });

      // Add to DLQ index
      await this.redis.zadd(this.buildDLQIndexKey(), {
        member: zombie.executionId,
        score: Date.now(),
      });

      // Determine recovery strategy for non-failed sagas
      if (zombie.status === "COMPENSATING" || zombie.stepStates.some(s => s.status === "failed")) {
        // Retry compensation
        return await this.retryCompensation(zombie);
      } else {
        // Resume execution
        return await this.resumeExecution(zombie);
      }
    } catch (error) {
      console.error(`[DLQ] Recovery failed for ${zombie.executionId}:`, error);
      await this.escalateToHuman(zombie, error instanceof Error ? error.message : String(error));
      return {
        success: false,
        action: "ESCALATED",
        message: `Recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Resume execution of a zombie saga
   */
  private async resumeExecution(zombie: ZombieSaga): Promise<{
    success: boolean;
    action: "RESUMED";
    message?: string;
  }> {
    console.log(`[DLQ] Attempting to resume zombie saga ${zombie.executionId}`);

    try {
      // Publish WORKFLOW_RESUME event to trigger continuation
      await RealtimeService.publishNervousSystemEvent(
        "WORKFLOW_RESUME",
        {
          executionId: zombie.executionId,
          workflowId: zombie.workflowId,
          intentId: zombie.intentId,
          reason: "DLQ_RECOVERY",
          recoveryAttempt: zombie.recoveryAttempts + 1,
          timestamp: new Date().toISOString(),
        },
        undefined
      );

      console.log(`[DLQ] Resumed zombie saga ${zombie.executionId} (attempt ${zombie.recoveryAttempts + 1})`);

      return {
        success: true,
        action: "RESUMED",
        message: `Resumed execution (attempt ${zombie.recoveryAttempts + 1})`,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Retry compensation for a zombie saga
   */
  private async retryCompensation(zombie: ZombieSaga): Promise<{
    success: boolean;
    action: "COMPENSATION_RETRIED" | "ESCALATED";
    message?: string;
  }> {
    console.log(`[DLQ] Retrying compensation for zombie saga ${zombie.executionId}`);

    if (!zombie.compensationsRegistered || zombie.compensationsRegistered.length === 0) {
      // No compensations to retry - escalate
      await this.escalateToHuman(zombie, "No compensations registered but saga has failed steps");
      return {
        success: false,
        action: "ESCALATED",
        message: "No compensations registered",
      };
    }

    // Publish compensation retry event
    await RealtimeService.publishNervousSystemEvent(
      "COMPENSATION_RETRY",
      {
        executionId: zombie.executionId,
        workflowId: zombie.workflowId,
        compensationsToRetry: zombie.compensationsRegistered,
        recoveryAttempt: zombie.recoveryAttempts + 1,
        timestamp: new Date().toISOString(),
      },
      undefined
    );

    console.log(`[DLQ] Retried compensation for zombie saga ${zombie.executionId}`);

    return {
      success: true,
      action: "COMPENSATION_RETRIED",
      message: `Retried compensation (attempt ${zombie.recoveryAttempts + 1})`,
    };
  }

  /**
   * Escalate zombie saga to human intervention
   */
  private async escalateToHuman(zombie: ZombieSaga, additionalError?: string): Promise<void> {
    console.warn(
      `[DLQ] Escalating zombie saga ${zombie.executionId} to human intervention`
    );

    try {
      // Publish to system alerts
      await RealtimeService.publish('system:alerts', 'zombie_saga_escalated', {
        executionId: zombie.executionId,
        workflowId: zombie.workflowId,
        intentId: zombie.intentId,
        userId: zombie.userId,
        status: zombie.status,
        inactiveDurationMs: zombie.inactiveDurationMs,
        inactiveDurationHuman: this.formatDuration(zombie.inactiveDurationMs),
        recoveryAttempts: zombie.recoveryAttempts,
        stepStates: zombie.stepStates,
        compensationsRegistered: zombie.compensationsRegistered,
        error: additionalError,
        severity: 'CRITICAL',
        requiresAction: true,
        timestamp: new Date().toISOString(),
      });

      // Also publish as nervous system event
      await RealtimeService.publishNervousSystemEvent(
        "SAGA_MANUAL_INTERVENTION_REQUIRED",
        {
          executionId: zombie.executionId,
          workflowId: zombie.workflowId,
          intentId: zombie.intentId,
          reason: "ZOMBIE_SAGA",
          inactiveDurationMs: zombie.inactiveDurationMs,
          recoveryAttempts: zombie.recoveryAttempts,
          error: additionalError,
          timestamp: new Date().toISOString(),
        },
        undefined
      );
    } catch (error) {
      console.error(`[DLQ] Failed to escalate zombie saga ${zombie.executionId}:`, error);
    }
  }

  /**
   * Run full reconciliation cycle
   *
   * SELF-HEALING: Tracks Repair Agent auto-repairs separately
   *
   * This should be called periodically (e.g., every 5 minutes) via cron
   */
  async runReconciliation(): Promise<ReconciliationResult> {
    console.log(`[DLQ] Starting reconciliation cycle...`);
    const startTime = Date.now();

    const zombieSagas = await this.scanForZombieSagas();
    const errors: Array<{ executionId: string; error: string }> = [];
    let autoRecovered = 0;
    let autoRepaired = 0; // Track Repair Agent auto-repairs
    let escalatedToHuman = 0;

    for (const zombie of zombieSagas) {
      try {
        const result = await this.recoverZombieSaga(zombie);

        if (result.action === "AUTO_REPAIRED") {
          autoRepaired++;
          autoRecovered++; // Count as recovered
        } else if (result.action === "RESUMED" || result.action === "COMPENSATION_RETRIED") {
          autoRecovered++;
        } else if (result.action === "ESCALATED") {
          escalatedToHuman++;
        }
      } catch (error) {
        errors.push({
          executionId: zombie.executionId,
          error: error instanceof Error ? error.message : String(error),
        });
        escalatedToHuman++;
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `[DLQ] Reconciliation complete in ${duration}ms: ` +
      `${zombieSagas.length} zombie sagas detected, ` +
      `${autoRepaired} auto-repaired by Repair Agent, ` +
      `${autoRecovered - autoRepaired} auto-recovered (standard), ` +
      `${escalatedToHuman} escalated to human`
    );

    return {
      scanned: zombieSagas.length,
      zombieSagasDetected: zombieSagas.length,
      autoRecovered,
      escalatedToHuman,
      errors,
    };
  }

  /**
   * Get DLQ statistics
   */
  async getStats(): Promise<DLQStats> {
    const zombieSagas = await this.scanForZombieSagas();
    
    const stats: DLQStats = {
      totalZombieSagas: zombieSagas.length,
      autoRecovered: 0,
      manualInterventionRequired: zombieSagas.filter(z => z.requiresHumanIntervention).length,
      avgInactiveDurationMs: 0,
      oldestZombieAgeMs: 0,
      byStatus: {},
    };

    if (zombieSagas.length > 0) {
      stats.avgInactiveDurationMs = Math.round(
        zombieSagas.reduce((sum, z) => sum + z.inactiveDurationMs, 0) / zombieSagas.length
      );
      stats.oldestZombieAgeMs = Math.max(...zombieSagas.map(z => z.inactiveDurationMs));

      // Group by status
      for (const zombie of zombieSagas) {
        stats.byStatus[zombie.status] = (stats.byStatus[zombie.status] || 0) + 1;
      }
    }

    return stats;
  }

  /**
   * Remove execution from DLQ (after successful recovery)
   */
  async removeFromDLQ(executionId: string): Promise<void> {
    const dlqKey = this.buildDLQKey(executionId);
    await this.redis.del(dlqKey);
    await this.redis.zrem(this.buildDLQIndexKey(), executionId);
  }

  /**
   * Get DLQ entry for an execution
   */
  async getDLQEntry(executionId: string): Promise<any> {
    const dlqKey = this.buildDLQKey(executionId);
    return await this.redis.get(dlqKey);
  }

  /**
   * Clear old DLQ entries (older than 7 days)
   */
  async cleanupOldEntries(): Promise<number> {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const indexKey = this.buildDLQIndexKey();
    
    // Remove old entries from sorted set
    const removed = await this.redis.zremrangebyscore(indexKey, 0, sevenDaysAgo);
    
    console.log(`[DLQ] Cleaned up ${removed} old DLQ entries`);
    return removed || 0;
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else {
      return `${minutes}m`;
    }
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createDLQMonitoringService(
  redis: Redis,
  config?: Partial<DLQConfig>
): DLQMonitoringService {
  return new DLQMonitoringService(redis, config);
}
