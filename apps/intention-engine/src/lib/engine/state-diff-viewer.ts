/**
 * State Diff Viewer - Visual Saga Gantt Chart Support
 *
 * Captures and visualizes state transitions for debugging and post-mortem analysis.
 * Automatically integrated with WorkflowMachine.saveExecutionState to capture
 * diffs at every checkpoint.
 *
 * Features:
 * - Deep comparison of execution states
 * - Step-level diff tracking
 * - Budget and token usage delta calculation
 * - Timeline visualization support
 * - Redis-backed storage for historical analysis
 *
 * Usage:
 * ```typescript
 * // Automatic capture on state save
 * const state = await saveExecutionState(newState);
 *
 * // Manual diff generation
 * const diff = await StateDiffViewer.generateDiff(oldState, newState);
 *
 * // Retrieve historical diffs
 * const diffs = await StateDiffViewer.getExecutionDiffs(executionId);
 * ```
 *
 * @package apps/intention-engine
 */

import { redis } from "../redis-client";
import { ExecutionState, StepExecutionState } from "./types";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface StateDiff {
  executionId: string;
  timestamp: string;
  previousStatus: string;
  currentStatus: string;
  // Budget changes
  budgetDelta: {
    tokenDelta: number;
    costDelta: number;
  };
  // Step-level changes
  stepChanges: Array<{
    stepId: string;
    toolName: string;
    previousStatus?: string;
    currentStatus: string;
    changed: boolean;
    resultChanged?: boolean;
  }>;
  // Metadata
  segmentNumber?: number;
  completedSteps: number;
  totalSteps: number;
  isCheckpoint: boolean;
}

export interface ExecutionTimeline {
  executionId: string;
  diffs: StateDiff[];
  startTime: string;
  endTime?: string;
  totalDurationMs: number;
  stepGantt: Array<{
    stepId: string;
    toolName: string;
    startTime: string;
    endTime?: string;
    durationMs: number;
    status: string;
  }>;
}

// ============================================================================
// STATE DIFF VIEWER
// ============================================================================

export class StateDiffViewer {
  private static readonly DIFF_TTL = 7 * 24 * 60 * 60; // 7 days TTL

  /**
   * Generate a diff between two execution states
   */
  static generateDiff(
    oldState: ExecutionState,
    newState: ExecutionState,
    isCheckpoint: boolean = false
  ): StateDiff {
    const now = new Date().toISOString();

    // Calculate budget delta
    const budgetDelta = {
      tokenDelta: newState.token_usage.total_tokens - oldState.token_usage.total_tokens,
      costDelta: newState.budget.current_cost_usd - oldState.budget.current_cost_usd,
    };

    // Compare step states
    const stepChanges: StateDiff['stepChanges'] = [];
    const oldStepMap = new Map(oldState.step_states.map(s => [s.step_id, s]));
    const newStepMap = new Map(newState.step_states.map(s => [s.step_id, s]));

    // Check all steps in new state
    for (const [stepId, newStep] of newStepMap) {
      const oldStep = oldStepMap.get(stepId);
      const changed = !oldStep || oldStep.status !== newStep.status || oldStep.result !== newStep.result;

      stepChanges.push({
        stepId,
        toolName: newStep.tool_name,
        previousStatus: oldStep?.status,
        currentStatus: newStep.status,
        changed,
        resultChanged: oldStep?.result !== newStep.result,
      });
    }

    // Count completed steps
    const completedSteps = newState.step_states.filter(s => s.status === 'completed').length;
    const totalSteps = newState.step_states.length;

    return {
      executionId: newState.execution_id,
      timestamp: now,
      previousStatus: oldState.status,
      currentStatus: newState.status,
      budgetDelta,
      stepChanges,
      segmentNumber: (newState as any).segmentNumber,
      completedSteps,
      totalSteps,
      isCheckpoint,
    };
  }

  /**
   * Save a state diff to Redis
   */
  static async saveDiff(diff: StateDiff): Promise<void> {
    if (!redis) {
      console.warn('[StateDiffViewer] Redis not available, skipping diff storage');
      return;
    }

    try {
      const diffKey = `state:diff:${diff.executionId}:${Date.now()}`;
      await redis.setex(diffKey, this.DIFF_TTL, JSON.stringify(diff));

      // Add to execution's diff timeline
      const timelineKey = `state:diff:timeline:${diff.executionId}`;
      await redis.zadd(timelineKey, {
        member: diffKey,
        score: Date.now(),
      });

      // Keep timeline bounded (last 100 diffs)
      const currentCount = await redis.zcard(timelineKey);
      if (currentCount > 100) {
        const toRemove = await redis.zrange(timelineKey, 0, currentCount - 101);
        await Promise.all([
          redis.zremrangebyrank(timelineKey, 0, currentCount - 101),
          ...toRemove.map(key => redis.del(key)),
        ]);
      }

      console.log(
        `[StateDiffViewer] Saved diff for ${diff.executionId}: ` +
        `${diff.previousStatus} -> ${diff.currentStatus} ` +
        `(${diff.stepChanges.filter(s => s.changed).length} step changes)`
      );
    } catch (error) {
      console.error('[StateDiffViewer] Failed to save diff:', error);
    }
  }

  /**
   * Get all diffs for an execution (timeline)
   */
  static async getExecutionDiffs(executionId: string): Promise<StateDiff[]> {
    if (!redis) {
      return [];
    }

    try {
      const timelineKey = `state:diff:timeline:${executionId}`;
      const diffKeys = await redis.zrange(timelineKey, 0, -1);

      if (!diffKeys || diffKeys.length === 0) {
        return [];
      }

      const diffs = await Promise.all(
        diffKeys.map(async (key) => {
          const data = await redis.get<any>(key);
          if (!data) return null;
          return typeof data === 'string' ? JSON.parse(data) : data;
        })
      );

      return diffs.filter((d): d is StateDiff => d !== null);
    } catch (error) {
      console.error('[StateDiffViewer] Failed to get diffs:', error);
      return [];
    }
  }

  /**
   * Generate execution timeline with Gantt chart data
   */
  static async generateTimeline(executionId: string): Promise<ExecutionTimeline | null> {
    const diffs = await this.getExecutionDiffs(executionId);

    if (diffs.length === 0) {
      return null;
    }

    const startTime = diffs[0].timestamp;
    const endTime = diffs[diffs.length - 1].timestamp;
    const totalDurationMs = new Date(endTime).getTime() - new Date(startTime).getTime();

    // Build Gantt chart from step changes
    const stepTimings = new Map<string, {
      stepId: string;
      toolName: string;
      startTime: string;
      endTime?: string;
      status: string;
    }>();

    for (const diff of diffs) {
      for (const stepChange of diff.stepChanges) {
        if (!stepTimings.has(stepChange.stepId)) {
          stepTimings.set(stepChange.stepId, {
            stepId: stepChange.stepId,
            toolName: stepChange.toolName,
            startTime: diff.timestamp,
            status: stepChange.currentStatus,
          });
        } else {
          const timing = stepTimings.get(stepChange.stepId)!;
          if (stepChange.currentStatus === 'completed' || stepChange.currentStatus === 'failed') {
            timing.endTime = diff.timestamp;
          }
          timing.status = stepChange.currentStatus;
        }
      }
    }

    const stepGantt = Array.from(stepTimings.values()).map(timing => ({
      ...timing,
      durationMs: timing.endTime
        ? new Date(timing.endTime).getTime() - new Date(timing.startTime).getTime()
        : totalDurationMs,
    }));

    return {
      executionId,
      diffs,
      startTime,
      endTime,
      totalDurationMs,
      stepGantt,
    };
  }

  /**
   * Get the latest diff for an execution
   */
  static async getLatestDiff(executionId: string): Promise<StateDiff | null> {
    const diffs = await this.getExecutionDiffs(executionId);
    return diffs.length > 0 ? diffs[diffs.length - 1] : null;
  }

  /**
   * Clear all diffs for an execution
   */
  static async clearDiffs(executionId: string): Promise<void> {
    if (!redis) {
      return;
    }

    try {
      const timelineKey = `state:diff:timeline:${executionId}`;
      const diffKeys = await redis.zrange(timelineKey, 0, -1);

      if (diffKeys && diffKeys.length > 0) {
        await Promise.all([
          redis.del(timelineKey),
          ...diffKeys.map(key => redis.del(key)),
        ]);
      }

      console.log(`[StateDiffViewer] Cleared diffs for ${executionId}`);
    } catch (error) {
      console.error('[StateDiffViewer] Failed to clear diffs:', error);
    }
  }

  /**
   * Get summary statistics for an execution
   */
  static async getExecutionStats(executionId: string): Promise<{
    totalDiffs: number;
    totalCheckpoints: number;
    totalStepChanges: number;
    totalTokenUsage: number;
    totalCostUsd: number;
    averageStepDurationMs: number;
  } | null> {
    const timeline = await this.generateTimeline(executionId);

    if (!timeline) {
      return null;
    }

    const totalDiffs = timeline.diffs.length;
    const totalCheckpoints = timeline.diffs.filter(d => d.isCheckpoint).length;
    const totalStepChanges = timeline.diffs.reduce(
      (sum, d) => sum + d.stepChanges.filter(s => s.changed).length,
      0
    );

    const lastDiff = timeline.diffs[timeline.diffs.length - 1];
    const totalTokenUsage = lastDiff ? 
      timeline.diffs.reduce((sum, d) => sum + d.budgetDelta.tokenDelta, 0) : 0;
    const totalCostUsd = lastDiff ?
      timeline.diffs.reduce((sum, d) => sum + d.budgetDelta.costDelta, 0) : 0;

    const completedSteps = timeline.stepGantt.filter(s => s.status === 'completed');
    const averageStepDurationMs = completedSteps.length > 0
      ? completedSteps.reduce((sum, s) => sum + s.durationMs, 0) / completedSteps.length
      : 0;

    return {
      totalDiffs,
      totalCheckpoints,
      totalStepChanges,
      totalTokenUsage,
      totalCostUsd,
      averageStepDurationMs,
    };
  }
}

// ============================================================================
// INTEGRATION WITH SAVE EXECUTION STATE
// ============================================================================

let previousStateCache: Map<string, ExecutionState> = new Map();

/**
 * Wrap saveExecutionState to automatically capture state diffs
 *
 * This should be called by the WorkflowMachine whenever state is saved.
 * It captures the diff between the previous and new state, then stores
 * it for visualization.
 */
export async function captureStateDiffOnSave(
  newState: ExecutionState,
  isCheckpoint: boolean = false
): Promise<void> {
  const oldState = previousStateCache.get(newState.execution_id);

  if (oldState) {
    const diff = StateDiffViewer.generateDiff(oldState, newState, isCheckpoint);
    await StateDiffViewer.saveDiff(diff);
  }

  // Update cache
  previousStateCache.set(newState.execution_id, { ...newState });

  // Limit cache size (keep last 100 executions)
  if (previousStateCache.size > 100) {
    const firstKey = previousStateCache.keys().next().value;
    if (firstKey) {
      previousStateCache.delete(firstKey);
    }
  }
}

/**
 * Clear the previous state cache (useful for testing)
 */
export function clearStateCache(): void {
  previousStateCache.clear();
}
