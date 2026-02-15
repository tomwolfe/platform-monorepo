/**
 * Parallel Execution Schemas for MCP Protocol
 * Enables DAG-based parallel task execution with dependency tracking
 */

import { z } from "zod";

/**
 * DependencyType - Types of dependencies between steps
 */
export const DependencyTypeSchema = z.enum([
  "REQUIRES",       // Step B requires Step A to complete
  "CONFLICTS_WITH", // Step B cannot run if Step A is running
  "SHARES_STATE",   // Step B reads state written by Step A
]);

export type DependencyType = z.infer<typeof DependencyTypeSchema>;

/**
 * StepDependency - Defines a dependency between execution steps
 */
export const StepDependencySchema = z.object({
  dependencyId: z.string().uuid().describe("UUID of the step this step depends on"),
  dependencyType: DependencyTypeSchema.default("REQUIRES"),
  optional: z.boolean().default(false).describe("If true, step can proceed even if dependency fails"),
});

export type StepDependency = z.infer<typeof StepDependencySchema>;

/**
 * ParallelExecutionSchema - Wrapper for parallel execution metadata
 * Can be attached to Intents or PlanSteps to enable parallel execution tracking
 */
export const ParallelExecutionSchema = z.object({
  executionId: z.string().uuid().describe("Unique identifier for this parallel execution context"),
  batchId: z.string().optional().describe("Identifier for grouping related parallel executions"),
  maxParallelism: z.number().int().positive().default(5).describe("Maximum number of steps to execute in parallel"),
  executionMode: z.enum(["SEQUENTIAL", "PARALLEL", "DAG"]).default("DAG"),
  dependencies: z.array(StepDependencySchema).default([]),
  priority: z.number().int().min(0).max(100).default(50).describe("Execution priority (0-100, higher = more priority)"),
  timeoutMs: z.number().int().positive().default(30000).describe("Timeout for the entire parallel execution group"),
  retryPolicy: z.object({
    maxAttempts: z.number().int().positive().default(3),
    backoffMs: z.number().int().nonnegative().default(1000),
    maxBackoffMs: z.number().int().positive().default(30000),
  }).optional(),
});

export type ParallelExecution = z.infer<typeof ParallelExecutionSchema>;

/**
 * ParallelExecutionResult - Result of a parallel execution batch
 */
export const ParallelExecutionResultSchema = z.object({
  executionId: z.string().uuid(),
  batchId: z.string().optional(),
  status: z.enum(["PENDING", "RUNNING", "COMPLETED", "PARTIAL_FAILURE", "FAILED", "TIMEOUT"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  results: z.array(z.object({
    stepId: z.string().uuid(),
    status: z.enum(["SUCCESS", "FAILED", "SKIPPED", "TIMEOUT"]),
    output: z.unknown().optional(),
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }).optional(),
    latencyMs: z.number().int().nonnegative(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
  })),
  summary: z.object({
    totalSteps: z.number().int().nonnegative(),
    successfulSteps: z.number().int().nonnegative(),
    failedSteps: z.number().int().nonnegative(),
    skippedSteps: z.number().int().nonnegative(),
    totalLatencyMs: z.number().int().nonnegative(),
  }),
});

export type ParallelExecutionResult = z.infer<typeof ParallelExecutionResultSchema>;

/**
 * DependencyResolverInput - Input for the dependency resolver
 */
export const DependencyResolverInputSchema = z.object({
  intentId: z.string().uuid(),
  steps: z.array(z.object({
    stepId: z.string().uuid(),
    toolName: z.string(),
    parameters: z.record(z.string(), z.unknown()),
    estimatedTokens: z.number().int().nonnegative().optional(),
  })),
  constraints: z.object({
    maxParallelism: z.number().int().positive().default(5),
    respectToolRateLimits: z.boolean().default(true),
    preventConflictingOperations: z.boolean().default(true),
  }).optional(),
});

export type DependencyResolverInput = z.infer<typeof DependencyResolverInputSchema>;

/**
 * DependencyResolverOutput - Output from the dependency resolver
 * Groups steps into parallelizable batches
 */
export const DependencyResolverOutputSchema = z.object({
  intentId: z.string().uuid(),
  batches: z.array(z.object({
    batchNumber: z.number().int().nonnegative(),
    steps: z.array(z.string().uuid()).describe("Step IDs in this batch"),
    canExecuteInParallel: z.boolean(),
    estimatedBatchLatencyMs: z.number().int().nonnegative(),
  })),
  dependencyGraph: z.record(z.string().uuid(), z.array(z.string().uuid())).describe("Step ID -> dependent step IDs"),
  analysis: z.object({
    totalSteps: z.number().int().nonnegative(),
    parallelizableGroups: z.number().int().nonnegative(),
    sequentialGroups: z.number().int().nonnegative(),
    estimatedTotalLatencyMs: z.number().int().nonnegative(),
    optimizationSuggestions: z.array(z.string()).optional(),
  }),
});

export type DependencyResolverOutput = z.infer<typeof DependencyResolverOutputSchema>;
