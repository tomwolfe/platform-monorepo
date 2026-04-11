/**
 * Dependency Resolver for IntentionEngine
 * Analyzes plans to identify parallelizable steps and build execution batches
 */

import { Plan, PlanStep } from "./types";
import { DependencyResolverOutput } from "@repo/mcp-protocol";

// ============================================================================
// PURE HELPER FUNCTIONS FOR KAHN'S ALGORITHM
// Extracted for testability and reduced cyclomatic complexity
// ============================================================================

/**
 * Builds adjacency list and reverse adjacency list from plan steps
 */
function buildAdjacencyLists(plan: Plan): {
  adjacency: Map<string, Set<string>>;
  reverseAdj: Map<string, Set<string>>;
} {
  const adjacency = new Map<string, Set<string>>(); // stepId -> steps that depend on it
  const reverseAdj = new Map<string, Set<string>>(); // stepId -> steps it depends on

  for (const step of plan.steps) {
    adjacency.set(step.id, new Set());
    reverseAdj.set(step.id, new Set(step.dependencies));
  }

  for (const step of plan.steps) {
    for (const depId of step.dependencies) {
      adjacency.get(depId)?.add(step.id);
    }
  }

  return { adjacency, reverseAdj };
}

/**
 * Initializes in-degree map for all steps
 */
function buildInDegreeMap(plan: Plan): Map<string, number> {
  const inDegree = new Map<string, number>();

  for (const step of plan.steps) {
    inDegree.set(step.id, step.dependencies.length);
  }

  return inDegree;
}

/**
 * Finds all steps that are ready to execute (in-degree = 0 and not visited)
 */
function findReadySteps(
  plan: Plan,
  visited: Set<string>,
  inDegree: Map<string, number>,
): PlanStep[] {
  const readySteps: PlanStep[] = [];

  for (const step of plan.steps) {
    if (!visited.has(step.id) && (inDegree.get(step.id) || 0) === 0) {
      readySteps.push(step);
    }
  }

  return readySteps;
}

/**
 * Updates in-degree for all dependents of a completed step
 */
function updateDependentDegrees(
  stepId: string,
  adjacency: Map<string, Set<string>>,
  inDegree: Map<string, number>,
): void {
  for (const dependentId of Array.from(
    adjacency.get(stepId) || new Set<string>(),
  )) {
    const currentDegree = inDegree.get(dependentId) || 0;
    inDegree.set(dependentId, currentDegree - 1);
  }
}

/**
 * Estimates the latency for executing a batch of steps
 */
function estimateBatchLatency(steps: PlanStep[]): number {
  // Batch latency is the max of all step latencies (parallel execution)
  return Math.max(...steps.map((s) => s.timeout_ms || 30000), 0);
}

/**
 * Generates optimization suggestions based on plan analysis
 */
function generateOptimizationSuggestions(
  plan: Plan,
  batches: Array<{ stepIds: string[]; canExecuteInParallel: boolean }>,
): string[] {
  const suggestions: string[] = [];

  // Check for sequential bottlenecks
  const sequentialBatches = batches.filter(
    (b) => !b.canExecuteInParallel && b.stepIds.length === 1,
  );
  if (sequentialBatches.length > plan.steps.length / 2) {
    suggestions.push(
      "Plan has many sequential dependencies; consider restructuring independent operations",
    );
  }

  // Check for potential fan-out opportunities
  const fanOutCandidates = plan.steps.filter((s) =>
    Object.values(s.parameters).some((val) => Array.isArray(val)),
  );
  if (fanOutCandidates.length > 0) {
    suggestions.push(
      `Found ${fanOutCandidates.length} steps that may benefit from fan-out execution`,
    );
  }

  // Check for steps with high estimated tokens
  const highTokenSteps = plan.steps.filter(
    (s) => (s.estimated_tokens || 0) > 1000,
  );
  if (highTokenSteps.length > 0) {
    suggestions.push(
      `${highTokenSteps.length} steps have high token estimates (>1000); consider breaking them down`,
    );
  }

  return suggestions;
}

/**
 * DependencyResolver
 * Scans execution plans to identify steps that can run in parallel
 *
 * Key Constraints:
 * - Steps with no shared dependencies can run in parallel
 * - Steps that write to the same state must be sequential
 * - Steps with explicit conflicts cannot run in parallel
 */
export class DependencyResolver {
  /**
   * Analyzes a plan and returns parallel execution batches
   *
   * @param plan - The execution plan to analyze
   * @returns Batches of steps grouped by parallelizable groups
   */
  static resolveDependencies(plan: Plan): DependencyResolverOutput {
    const startTime = performance.now();

    // Build graph structures
    const { adjacency } = buildAdjacencyLists(plan);

    // Detect state conflicts (steps that write to same output)
    const stateConflicts = this.detectStateConflicts(plan);

    // Initialize execution tracking
    const batches: Array<{ stepIds: string[]; canExecuteInParallel: boolean }> =
      [];
    const visited = new Set<string>();
    const inDegree = buildInDegreeMap(plan);

    // Kahn's algorithm with parallel batching
    while (visited.size < plan.steps.length) {
      // Find all steps ready to execute
      const readySteps = findReadySteps(plan, visited, inDegree);

      if (readySteps.length === 0) {
        // This shouldn't happen if the plan is a valid DAG
        throw new Error("Circular dependency detected in plan");
      }

      // Group ready steps by conflict sets
      const parallelizableGroups = this.groupByConflicts(
        readySteps,
        stateConflicts,
      );

      // Create batches from groups
      for (const group of parallelizableGroups) {
        batches.push({
          stepIds: group.map((s) => s.id),
          canExecuteInParallel: group.length > 1,
        });

        // Mark all steps in this batch as visited and update degrees
        for (const step of group) {
          visited.add(step.id);
          updateDependentDegrees(step.id, adjacency, inDegree);
        }
      }
    }

    // Build dependency graph for output
    const dependencyGraph: Record<string, string[]> = {};
    for (const step of plan.steps) {
      dependencyGraph[step.id] = Array.from(adjacency.get(step.id) || []);
    }

    const endTime = performance.now();

    return {
      intentId: plan.intent_id,
      batches: batches.map((batch, index) => ({
        batchNumber: index,
        steps: batch.stepIds,
        canExecuteInParallel: batch.canExecuteInParallel,
        estimatedBatchLatencyMs: estimateBatchLatency(
          batch.stepIds.map((id) => plan.steps.find((s) => s.id === id)!),
        ),
      })),
      dependencyGraph,
      analysis: {
        totalSteps: plan.steps.length,
        parallelizableGroups: batches.filter((b) => b.canExecuteInParallel)
          .length,
        sequentialGroups: batches.filter((b) => !b.canExecuteInParallel).length,
        estimatedTotalLatencyMs: Math.round(endTime - startTime),
        optimizationSuggestions: generateOptimizationSuggestions(plan, batches),
      },
    };
  }

  /**
   * Detects state conflicts between steps
   * Steps that write to the same output parameter are in conflict
   */
  private static detectStateConflicts(plan: Plan): Map<string, Set<string>> {
    const conflicts = new Map<string, Set<string>>();
    const outputWrites = new Map<string, string[]>(); // outputKey -> stepIds that write to it

    for (const step of plan.steps) {
      // Analyze parameters for output references
      for (const [key, value] of Object.entries(step.parameters)) {
        if (typeof value === "string" && value.startsWith("$")) {
          // This is an input reference, not an output write
          continue;
        }

        // Track potential state writes based on tool patterns
        const outputKey = `${step.tool_name}:${key}`;
        if (!outputWrites.has(outputKey)) {
          outputWrites.set(outputKey, []);
        }
        outputWrites.get(outputKey)!.push(step.id);
      }
    }

    // Build conflict graph
    for (const [_outputKey, stepIds] of outputWrites) {
      if (stepIds.length > 1) {
        for (const stepId of stepIds) {
          if (!conflicts.has(stepId)) {
            conflicts.set(stepId, new Set());
          }
          for (const otherStepId of stepIds) {
            if (stepId !== otherStepId) {
              conflicts.get(stepId)!.add(otherStepId);
            }
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * Groups steps into conflict-free parallelizable sets
   */
  private static groupByConflicts(
    steps: PlanStep[],
    conflicts: Map<string, Set<string>>,
  ): PlanStep[][] {
    if (steps.length <= 1) {
      return [steps];
    }

    const groups: PlanStep[][] = [];
    const assigned = new Set<string>();

    // Greedy grouping: put as many non-conflicting steps together as possible
    for (const step of steps) {
      if (assigned.has(step.id)) continue;

      const group: PlanStep[] = [step];
      assigned.add(step.id);

      for (const otherStep of steps) {
        if (assigned.has(otherStep.id)) continue;

        // Check if this step conflicts with any in the group
        let hasConflict = false;
        for (const groupedStep of group) {
          const stepConflicts = conflicts.get(groupedStep.id);
          if (stepConflicts?.has(otherStep.id)) {
            hasConflict = true;
            break;
          }
        }

        if (!hasConflict) {
          group.push(otherStep);
          assigned.add(otherStep.id);
        }
      }

      groups.push(group);
    }

    return groups;
  }

  /**
   * Determines if two steps can execute in parallel
   *
   * @param stepA - First step
   * @param stepB - Second step
   * @returns true if steps can execute in parallel
   */
  static canExecuteInParallel(stepA: PlanStep, stepB: PlanStep): boolean {
    // Check if either depends on the other
    if (
      stepA.dependencies.includes(stepB.id) ||
      stepB.dependencies.includes(stepA.id)
    ) {
      return false;
    }

    // Check for shared write conflicts
    const aOutputs = this.extractOutputKeys(stepA);
    const bOutputs = this.extractOutputKeys(stepB);

    for (const output of aOutputs) {
      if (bOutputs.has(output)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Extracts output keys that a step writes to
   */
  private static extractOutputKeys(step: PlanStep): Set<string> {
    const outputs = new Set<string>();

    const scanRecursively = (obj: unknown, path: string[] = []): void => {
      if (!obj) return;
      if (typeof obj === "string" && obj.startsWith("$")) {
        // It's an input reference, skip
        return;
      }
      if (typeof obj === "object") {
        const record = obj as Record<string, unknown>;
        for (const [key, value] of Object.entries(record)) {
          if (typeof value === "string" && !value.startsWith("$")) {
            outputs.add(`${step.tool_name}:${key}`);
          } else if (typeof value === "object" && value !== null) {
            scanRecursively(value, [...path, key]);
          }
        }
      }
    };

    scanRecursively(step.parameters);
    return outputs;
  }
}

/**
 * BatchExecutionPlanner
 * Plans the execution of parallel batches with proper dependency tracking
 */
export class BatchExecutionPlanner {
  private resolverOutput: DependencyResolverOutput;
  private currentBatchIndex: number = 0;

  constructor(plan: Plan) {
    this.resolverOutput = DependencyResolver.resolveDependencies(plan);
  }

  /**
   * Get the next batch of steps to execute
   */
  getNextBatch(): { batchNumber: number; stepIds: string[] } | null {
    if (this.currentBatchIndex >= this.resolverOutput.batches.length) {
      return null;
    }

    const batch = this.resolverOutput.batches[this.currentBatchIndex];
    if (!batch) return null;

    return {
      batchNumber: batch.batchNumber,
      stepIds: batch.steps,
    };
  }

  /**
   * Mark current batch as complete and advance to next
   */
  advanceBatch(): void {
    this.currentBatchIndex++;
  }

  /**
   * Check if all batches are complete
   */
  isComplete(): boolean {
    return this.currentBatchIndex >= this.resolverOutput.batches.length;
  }

  /**
   * Get the full resolution analysis
   */
  getAnalysis(): DependencyResolverOutput["analysis"] {
    return this.resolverOutput.analysis;
  }
}
