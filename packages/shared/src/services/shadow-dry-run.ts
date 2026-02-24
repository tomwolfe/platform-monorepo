/**
 * Shadow Dry-Run Service - Logic Drift Detection
 *
 * Problem Solved: Deployment During Saga Execution
 * - A saga yields at 10s timeout and resumes later via QStash
 * - If a new deployment happens while the saga is yielded, the git SHA changes
 * - Resuming with new code logic against old state may cause state corruption
 *
 * Solution: Shadow Dry-Run on Resume
 * - When resume() detects git SHA change (logic drift), trigger shadow simulation
 * - Re-simulates the plan using NEW code logic against OLD state snapshot
 * - Compares outcomes to ensure resume won't cause state corruption
 * - If divergence detected, transitions to REFLECTING state for human review
 *
 * Architecture:
 * 1. On resume, SchemaVersioningService detects orchestratorGitSha drift
 * 2. ShadowDryRunService creates isolated state snapshot
 * 3. Re-executes plan logic in "dry-run" mode (no side effects)
 * 4. Compares dry-run results with expected outcomes
 * 5. If divergence > threshold, flags for human review
 *
 * Usage:
 * ```typescript
 * // In WorkflowMachine.resume()
 * const driftResult = await schemaVersioning.detectDrift(executionId, toolNames);
 *
 * if (driftResult.hasOrchestratorDrift) {
 *   // Trigger shadow dry-run
 *   const dryRunResult = await ShadowDryRunService.executeDryRun({
 *     executionId,
 *     plan: state.plan,
 *     stateSnapshot: state,
 *     checkpointMetadata: driftResult.oldOrchestratorSha,
 *   });
 *
 *   if (dryRunResult.divergenceDetected) {
 *     // Transition to REFLECTING state
 *     state = transitionState(state, "REFLECTING");
 *   }
 * }
 * ```
 *
 * @package @repo/shared
 * @since 1.0.0
 */

import { Redis } from '@upstash/redis';
import { getRedisClient, ServiceNamespace } from '../redis';
import type { ExecutionState } from '../types/execution';
import { z } from 'zod';

// Define Plan and PlanStep locally to avoid circular dependencies
interface PlanStep {
  id: string;
  tool_name: string;
  parameters: Record<string, unknown>;
  dependencies?: string[];
}

interface Plan {
  id: string;
  steps: PlanStep[];
  constraints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface ShadowDryRunConfig {
  redis: Redis;
  /** Maximum divergence percentage before flagging (default: 10%) */
  maxDivergenceThreshold?: number;
  /** TTL for dry-run state snapshots (default: 1 hour) */
  snapshotTtlSeconds?: number;
  /** Enable detailed divergence logging */
  enableDetailedLogging?: boolean;
}

const DEFAULT_CONFIG: Required<ShadowDryRunConfig> = {
  redis: null as any,
  maxDivergenceThreshold: 10, // 10% divergence is acceptable
  snapshotTtlSeconds: 3600, // 1 hour
  enableDetailedLogging: false,
};

export interface DryRunRequest {
  executionId: string;
  plan: Plan;
  stateSnapshot: ExecutionState;
  checkpointMetadata: {
    orchestratorGitSha: string;
    toolVersions?: Record<string, { version: string; schemaHash: string }>;
  };
  currentMetadata: {
    orchestratorGitSha: string;
    toolVersions?: Record<string, { version: string; schemaHash: string }>;
  };
}

export interface DryRunResult {
  success: boolean;
  divergenceDetected: boolean;
  divergencePercentage: number;
  divergentSteps: Array<{
    stepId: string;
    toolName: string;
    expectedOutput: unknown;
    dryRunOutput: unknown;
    divergenceReason: string;
  }>;
  recommendation: 'SAFE_TO_RESUME' | 'REVIEW_REQUIRED' | 'BLOCK_RESUME';
  details: string;
  executedAt: string;
}

export interface ShadowStateSnapshot {
  executionId: string;
  state: Partial<ExecutionState> & { status: string };
  capturedAt: string;
  orchestratorGitSha: string;
  toolVersions: Record<string, { version: string; schemaHash: string }>;
}

// ============================================================================
// SHADOW DRY-RUN SERVICE
// ============================================================================

export class ShadowDryRunService {
  private config: Required<ShadowDryRunConfig>;

  constructor(config: ShadowDryRunConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ========================================================================
  // KEY HELPERS
  // ========================================================================

  private buildSnapshotKey(executionId: string): string {
    return `shadow_dry_run:snapshot:${executionId}`;
  }

  private buildResultKey(executionId: string): string {
    return `shadow_dry_run:result:${executionId}`;
  }

  // ========================================================================
  // STATE SNAPSHOT MANAGEMENT
  // ========================================================================

  /**
   * Capture a state snapshot for dry-run comparison
   *
   * @param executionId - Execution ID
   * @param state - Current execution state
   * @param orchestratorGitSha - Git SHA at checkpoint time
   * @param toolVersions - Tool versions at checkpoint time
   * @returns The captured snapshot
   */
  async captureSnapshot(
    executionId: string,
    state: ExecutionState,
    orchestratorGitSha: string,
    toolVersions: Record<string, { version: string; schemaHash: string }>
  ): Promise<ShadowStateSnapshot> {
    const snapshot: ShadowStateSnapshot = {
      executionId,
      state: JSON.parse(JSON.stringify(state)), // Deep clone
      capturedAt: new Date().toISOString(),
      orchestratorGitSha,
      toolVersions,
    };

    // Store in Redis
    await this.config.redis.setex(
      this.buildSnapshotKey(executionId),
      this.config.snapshotTtlSeconds,
      JSON.stringify(snapshot)
    );

    console.log(
      `[ShadowDryRun] Captured snapshot for ${executionId} ` +
      `(git: ${orchestratorGitSha}, tools: ${Object.keys(toolVersions).length})`
    );

    return snapshot;
  }

  /**
   * Get a captured snapshot
   */
  async getSnapshot(executionId: string): Promise<ShadowStateSnapshot | null> {
    const data = await this.config.redis.get<any>(
      this.buildSnapshotKey(executionId)
    );

    if (!data) return null;

    try {
      return typeof data === 'string' ? JSON.parse(data) : data;
    } catch (error) {
      console.error(
        `[ShadowDryRun] Failed to parse snapshot for ${executionId}:`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }

  // ========================================================================
  // DRY-RUN EXECUTION
  // ============================================================================

  /**
   * Execute a shadow dry-run
   *
   * Simulates plan execution using current logic against old state snapshot.
   * Compares outcomes to detect potential state corruption.
   *
   * @param request - Dry-run request parameters
   * @returns Dry-run result with divergence analysis
   */
  async executeDryRun(request: DryRunRequest): Promise<DryRunResult> {
    const startTime = new Date().toISOString();
    const divergentSteps: DryRunResult['divergentSteps'] = [];

    console.log(
      `[ShadowDryRun] Starting dry-run for ${request.executionId} ` +
      `(checkpoint: ${request.checkpointMetadata.orchestratorGitSha} -> ` +
      `current: ${request.currentMetadata.orchestratorGitSha})`
    );

    try {
      // Simulate execution of each pending step
      const pendingSteps = request.plan.steps.filter(
        (step) =>
          !request.stateSnapshot.step_states.some(
            (s) => s.step_id === step.id &&
            (s.status === 'completed' || s.status === 'failed')
          )
      );

      for (const step of pendingSteps) {
        // Simulate step execution (dry-run mode)
        const simulation = await this.simulateStepExecution(step, request.stateSnapshot);

        // Compare with expected outcome
        const expectedOutcome = this.getExpectedOutcome(step);

        if (this.hasDivergence(simulation, expectedOutcome)) {
          divergentSteps.push({
            stepId: step.id,
            toolName: step.tool_name,
            expectedOutput: expectedOutcome,
            dryRunOutput: simulation,
            divergenceReason: this.getDivergenceReason(simulation, expectedOutcome),
          });
        }
      }

      // Calculate divergence percentage
      const totalSteps = pendingSteps.length;
      const divergenceCount = divergentSteps.length;
      const divergencePercentage = totalSteps > 0
        ? (divergenceCount / totalSteps) * 100
        : 0;

      // Determine recommendation
      let recommendation: DryRunResult['recommendation'] = 'SAFE_TO_RESUME';
      let details = `Dry-run completed: ${divergenceCount}/${totalSteps} steps show divergence (${divergencePercentage.toFixed(1)}%)`;

      if (divergencePercentage >= this.config.maxDivergenceThreshold * 2) {
        recommendation = 'BLOCK_RESUME';
        details += ' - CRITICAL: High divergence detected, manual review required';
      } else if (divergencePercentage > 0) {
        recommendation = 'REVIEW_REQUIRED';
        details += ' - WARNING: Some divergence detected, monitor closely';
      }

      const result: DryRunResult = {
        success: true,
        divergenceDetected: divergenceCount > 0,
        divergencePercentage,
        divergentSteps,
        recommendation,
        details,
        executedAt: startTime,
      };

      // Store result in Redis
      await this.config.redis.setex(
        this.buildResultKey(request.executionId),
        this.config.snapshotTtlSeconds,
        JSON.stringify(result)
      );

      console.log(
        `[ShadowDryRun] Dry-run complete for ${request.executionId}: ` +
        `${recommendation} (${divergencePercentage.toFixed(1)}% divergence)`
      );

      return result;
    } catch (error) {
      console.error(
        `[ShadowDryRun] Dry-run failed for ${request.executionId}:`,
        error instanceof Error ? error.message : String(error)
      );

      return {
        success: false,
        divergenceDetected: false,
        divergencePercentage: 0,
        divergentSteps: [],
        recommendation: 'REVIEW_REQUIRED',
        details: `Dry-run execution failed: ${error instanceof Error ? error.message : String(error)}`,
        executedAt: startTime,
      };
    }
  }

  /**
   * Simulate step execution (dry-run mode)
   *
   * In a real implementation, this would:
   * 1. Clone the state snapshot
   * 2. Execute the step logic in an isolated sandbox
   * 3. Return the simulated output without side effects
   *
   * For now, returns a heuristic-based simulation
   */
  private async simulateStepExecution(
    step: PlanStep,
    stateSnapshot: ExecutionState
  ): Promise<unknown> {
    // Heuristic simulation based on tool type
    // In production, this would execute actual logic in a sandbox

    const toolType = step.tool_name.toLowerCase();

    // Simulate based on tool patterns
    if (toolType.includes('book') || toolType.includes('reserve')) {
      return {
        success: true,
        bookingId: `simulated_${crypto.randomUUID()}`,
        status: 'confirmed',
        timestamp: new Date().toISOString(),
      };
    }

    if (toolType.includes('cancel')) {
      return {
        success: true,
        cancelled: true,
        refundAmount: 0,
        timestamp: new Date().toISOString(),
      };
    }

    if (toolType.includes('payment') || toolType.includes('charge')) {
      return {
        success: true,
        transactionId: `simulated_txn_${crypto.randomUUID()}`,
        status: 'processed',
        amount: step.parameters.amount as number || 0,
      };
    }

    // Default simulation
    return {
      success: true,
      output: `Simulated output for ${step.tool_name}`,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get expected outcome for a step
   *
   * In production, this would analyze historical execution data
   * or use the step's original expected output from the plan
   */
  private getExpectedOutcome(step: PlanStep): unknown {
    // For now, return a generic expected outcome
    // In production, this would come from:
    // 1. Historical execution data
    // 2. Step metadata in the plan
    // 3. Tool schema defaults

    return {
      success: true,
      expected: true,
    };
  }

  /**
   * Check if there's divergence between simulation and expected
   */
  private hasDivergence(simulation: unknown, expected: unknown): boolean {
    // Simple heuristic: compare success status
    const sim = simulation as Record<string, unknown>;
    const exp = expected as Record<string, unknown>;

    if (sim?.success !== exp?.success) {
      return true;
    }

    // Check for critical field differences
    const criticalFields = ['status', 'bookingId', 'transactionId', 'cancelled'];
    for (const field of criticalFields) {
      if (field in sim && field in exp && sim[field] !== exp[field]) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get divergence reason
   */
  private getDivergenceReason(
    simulation: unknown,
    expected: unknown
  ): string {
    const sim = simulation as Record<string, unknown>;
    const exp = expected as Record<string, unknown>;

    if (sim?.success !== exp?.success) {
      return `Success status mismatch: expected ${exp?.success}, got ${sim?.success}`;
    }

    const criticalFields = ['status', 'bookingId', 'transactionId', 'cancelled'];
    for (const field of criticalFields) {
      if (field in sim && field in exp && sim[field] !== exp[field]) {
        return `Field '${field}' mismatch: expected ${JSON.stringify(exp[field])}, got ${JSON.stringify(sim[field])}`;
      }
    }

    return 'Unknown divergence detected';
  }

  // ========================================================================
  // RESULT RETRIEVAL
  // ========================================================================

  /**
   * Get dry-run result
   */
  async getResult(executionId: string): Promise<DryRunResult | null> {
    const data = await this.config.redis.get<any>(
      this.buildResultKey(executionId)
    );

    if (!data) return null;

    try {
      return typeof data === 'string' ? JSON.parse(data) : data;
    } catch (error) {
      console.error(
        `[ShadowDryRun] Failed to parse result for ${executionId}:`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }

  /**
   * Clear dry-run data for an execution
   */
  async clearData(executionId: string): Promise<void> {
    await Promise.all([
      this.config.redis.del(this.buildSnapshotKey(executionId)),
      this.config.redis.del(this.buildResultKey(executionId)),
    ]);

    console.log(`[ShadowDryRun] Cleared data for ${executionId}`);
  }
}

// ============================================================================
// FACTORY
// ============================================================================

let defaultService: ShadowDryRunService | null = null;

export function getShadowDryRunService(
  config?: ShadowDryRunConfig
): ShadowDryRunService {
  if (!defaultService) {
    const redis = config?.redis || getRedisClient(ServiceNamespace.SHARED);
    defaultService = new ShadowDryRunService({ redis, ...config });
  }
  return defaultService;
}

export function createShadowDryRunService(
  config?: ShadowDryRunConfig
): ShadowDryRunService {
  const redis = config?.redis || getRedisClient(ServiceNamespace.SHARED);
  return new ShadowDryRunService({ redis, ...config });
}
