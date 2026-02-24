/**
 * Deterministic Dry-Run Simulation Service
 *
 * Implements a SIMULATION mode for WorkflowMachine that validates plans
 * before execution without making any state-modifying operations.
 *
 * Features:
 * - Read-only tool registry access
 * - Parameter validation against schemas
 * - Dependency conflict detection
 * - Dead-on-arrival plan detection
 * - Cost estimation for LLM operations
 *
 * Use Cases:
 * 1. Pre-flight validation before saga execution
 * 2. Testing plan feasibility without side effects
 * 3. Cost estimation and budget checking
 * 4. Dependency graph validation
 *
 * @since 1.1.0
 */

import { z } from "zod";
import { getTypedToolEntry, type AllToolsMap } from "@repo/mcp-protocol";

// Plan and PlanStep types (simplified for shared package)
interface PlanStep {
  id: string;
  tool_name: string;
  description?: string;
  parameters: Record<string, unknown>;
  depends_on?: string[];
  state?: string;
  step_number?: number; // Added for step index tracking
}

interface Plan {
  id: string;
  steps: PlanStep[];
  metadata?: Record<string, unknown>;
}

// ============================================================================
// SIMULATION RESULT SCHEMAS
// ============================================================================

export const SimulationSeveritySchema = z.enum([
  "INFO",
  "WARNING",
  "ERROR",
  "CRITICAL",
]);

export type SimulationSeverity = z.infer<typeof SimulationSeveritySchema>;

/**
 * Individual simulation finding
 */
export const SimulationFindingSchema = z.object({
  severity: SimulationSeveritySchema,
  stepIndex: z.number().optional(),
  toolName: z.string().optional(),
  category: z.enum([
    "PARAM_VALIDATION",
    "SCHEMA_MISMATCH",
    "DEPENDENCY_CONFLICT",
    "RESOURCE_UNAVAILABLE",
    "COST_WARNING",
    "TIMEOUT_RISK",
    "IDEMPOTENCY_CONFLICT",
    "COMPENSATION_MISSING",
  ]),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  suggestion: z.string().optional(),
});

export type SimulationFinding = z.infer<typeof SimulationFindingSchema>;

/**
 * Step-level simulation result
 */
export const StepSimulationResultSchema = z.object({
  stepIndex: z.number(),
  toolName: z.string(),
  isValid: z.boolean(),
  wouldExecute: z.boolean(),
  findings: z.array(SimulationFindingSchema),
  estimatedDurationMs: z.number().optional(),
  estimatedCostUsd: z.number().optional(),
});

export type StepSimulationResult = z.infer<typeof StepSimulationResultSchema>;

/**
 * Overall simulation result
 */
export const SimulationResultSchema = z.object({
  success: z.boolean(),
  planId: z.string(),
  executionId: z.string(),
  totalSteps: z.number(),
  validSteps: z.number(),
  invalidSteps: z.number(),
  stepsThatWouldExecute: z.number(),
  stepsThatWouldSkip: z.number(),
  findings: z.array(SimulationFindingSchema),
  stepResults: z.array(StepSimulationResultSchema),
  estimatedTotalDurationMs: z.number(),
  estimatedTotalCostUsd: z.number(),
  recommendation: z.enum([
    "PROCEED",
    "PROCEED_WITH_WARNINGS",
    "FIX_AND_RETRY",
    "ABORT",
  ]),
  summary: z.string(),
});

export type SimulationResult = z.infer<typeof SimulationResultSchema>;

// ============================================================================
// SIMULATION CONFIGURATION
// ============================================================================

export interface SimulationConfig {
  // Enable cost estimation
  enableCostEstimation?: boolean;
  // Enable duration estimation
  enableDurationEstimation?: boolean;
  // Enable idempotency checking
  enableIdempotencyCheck?: boolean;
  // Strict mode: fail on warnings
  strictMode?: boolean;
  // Maximum acceptable cost (USD)
  maxCostUsd?: number;
  // Maximum acceptable duration (ms)
  maxDurationMs?: number;
}

const DEFAULT_CONFIG: Required<SimulationConfig> = {
  enableCostEstimation: true,
  enableDurationEstimation: true,
  enableIdempotencyCheck: true,
  strictMode: false,
  maxCostUsd: 1.00, // $1.00 max per execution
  maxDurationMs: 30000, // 30s max estimated duration
};

// ============================================================================
// DRY-RUN SIMULATION SERVICE
// ============================================================================

export class DryRunSimulationService {
  private config: Required<SimulationConfig>;

  constructor(config?: SimulationConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run a complete dry-run simulation on a plan
   */
  async simulatePlan(
    plan: Plan,
    executionId: string,
    options?: {
      userId?: string;
      existingExecutions?: Set<string>; // For idempotency checking
    }
  ): Promise<SimulationResult> {
    const findings: SimulationFinding[] = [];
    const stepResults: StepSimulationResult[] = [];
    
    let totalEstimatedDuration = 0;
    let totalEstimatedCost = 0;
    let validSteps = 0;
    let invalidSteps = 0;
    let wouldExecute = 0;
    let wouldSkip = 0;

    // Simulate each step
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const stepResult = await this.simulateStep(i, step, executionId, options);
      stepResults.push(stepResult);

      // Aggregate results
      if (stepResult.isValid) {
        validSteps++;
      } else {
        invalidSteps++;
      }

      if (stepResult.wouldExecute) {
        wouldExecute++;
      } else {
        wouldSkip++;
      }

      totalEstimatedDuration += stepResult.estimatedDurationMs || 0;
      totalEstimatedCost += stepResult.estimatedCostUsd || 0;

      // Collect findings
      findings.push(...stepResult.findings);
    }

    // Check for dependency conflicts
    const dependencyFindings = this.checkDependencyConflicts(plan.steps);
    findings.push(...dependencyFindings);

    // Check budget constraints
    if (this.config.enableCostEstimation && totalEstimatedCost > this.config.maxCostUsd) {
      findings.push({
        severity: "CRITICAL",
        category: "COST_WARNING",
        message: `Estimated cost ($${totalEstimatedCost.toFixed(3)}) exceeds budget ($${this.config.maxCostUsd.toFixed(2)})`,
        suggestion: "Reduce plan complexity or increase budget",
      });
    }

    // Check duration constraints
    if (this.config.enableDurationEstimation && totalEstimatedDuration > this.config.maxDurationMs) {
      findings.push({
        severity: "WARNING",
        category: "TIMEOUT_RISK",
        message: `Estimated duration (${totalEstimatedDuration}ms) exceeds recommended limit (${this.config.maxDurationMs}ms)`,
        suggestion: "Consider breaking into smaller segments",
      });
    }

    // Determine recommendation
    const criticalFindings = findings.filter(f => f.severity === "CRITICAL");
    const errorFindings = findings.filter(f => f.severity === "ERROR");
    const warningFindings = findings.filter(f => f.severity === "WARNING");

    let recommendation: SimulationResult["recommendation"] = "PROCEED";
    
    if (criticalFindings.length > 0 || invalidSteps > 0) {
      recommendation = "ABORT";
    } else if (errorFindings.length > 0) {
      recommendation = "FIX_AND_RETRY";
    } else if (warningFindings.length > 0) {
      recommendation = "PROCEED_WITH_WARNINGS";
    }

    if (this.config.strictMode && warningFindings.length > 0) {
      recommendation = "FIX_AND_RETRY";
    }

    // Generate summary
    const summary = this.generateSummary(
      plan.steps.length,
      validSteps,
      invalidSteps,
      wouldExecute,
      findings,
      recommendation
    );

    return {
      success: recommendation !== "ABORT",
      planId: plan.id,
      executionId,
      totalSteps: plan.steps.length,
      validSteps,
      invalidSteps,
      stepsThatWouldExecute: wouldExecute,
      stepsThatWouldSkip: wouldSkip,
      findings,
      stepResults,
      estimatedTotalDurationMs: totalEstimatedDuration,
      estimatedTotalCostUsd: totalEstimatedCost,
      recommendation,
      summary,
    };
  }

  /**
   * Simulate a single step
   */
  private async simulateStep(
    stepIndex: number,
    step: PlanStep,
    executionId: string,
    options?: {
      userId?: string;
      existingExecutions?: Set<string>;
    }
  ): Promise<StepSimulationResult> {
    const findings: SimulationFinding[] = [];

    // 1. Validate parameters against schema
    const validationFindings = this.validateParameters(step, stepIndex);
    findings.push(...validationFindings);

    // 2. Check idempotency (if enabled)
    if (this.config.enableIdempotencyCheck && options?.existingExecutions) {
      const idempotencyFindings = this.checkIdempotency(step, executionId, options.existingExecutions, stepIndex);
      findings.push(...idempotencyFindings);
    }

    // 3. Check if tool exists and is available
    const toolAvailability = this.checkToolAvailability(step.tool_name);
    findings.push(...toolAvailability);

    // 4. Estimate cost (if enabled)
    let estimatedCost: number | undefined;
    if (this.config.enableCostEstimation) {
      estimatedCost = this.estimateStepCost(step);
    }

    // 5. Estimate duration (if enabled)
    let estimatedDuration: number | undefined;
    if (this.config.enableDurationEstimation) {
      estimatedDuration = this.estimateStepDuration(step);
    }

    const isValid = findings.filter(f => f.severity === "ERROR" || f.severity === "CRITICAL").length === 0;
    const wouldExecute = isValid && !findings.some(f => f.category === "IDEMPOTENCY_CONFLICT");

    return {
      stepIndex,
      toolName: step.tool_name,
      isValid,
      wouldExecute,
      findings,
      estimatedDurationMs: estimatedDuration,
      estimatedCostUsd: estimatedCost,
    };
  }

  /**
   * Validate step parameters against tool schema
   */
  private validateParameters(step: PlanStep, stepIndex?: number): SimulationFinding[] {
    const findings: SimulationFinding[] = [];
    const index = stepIndex ?? step.step_number ?? 0;

    try {
      const tool = getTypedToolEntry(step.tool_name as keyof AllToolsMap);

      if (!tool) {
        findings.push({
          severity: "ERROR",
          stepIndex: index,
          toolName: step.tool_name,
          category: "SCHEMA_MISMATCH",
          message: `Tool "${step.tool_name}" not found in registry`,
          suggestion: "Verify tool name matches registered tools",
        });
        return findings;
      }

      // Simple parameter validation - check if required fields are present
      const schema = tool.schema;
      if (schema && "shape" in schema) {
        const shape = schema.shape as Record<string, { _def?: { required?: boolean } }>;
        const requiredFields = Object.entries(shape)
          .filter(([_, field]) => field._def?.required !== false)
          .map(([field]) => field);

        const missingFields = requiredFields.filter(
          field => !(field in (step.parameters || {}))
        );

        if (missingFields.length > 0) {
          findings.push({
            severity: "ERROR",
            stepIndex: index,
            toolName: step.tool_name,
            category: "PARAM_VALIDATION",
            message: `Missing required parameters: ${missingFields.join(", ")}`,
            details: { missingFields },
            suggestion: "Provide all required parameters before execution",
          });
        }
      }
    } catch (error) {
      findings.push({
        severity: "ERROR",
        stepIndex: index,
        toolName: step.tool_name,
        category: "SCHEMA_MISMATCH",
        message: `Schema validation error: ${error instanceof Error ? error.message : "Unknown error"}`,
        suggestion: "Review tool schema and parameters",
      });
    }

    return findings;
  }

  /**
   * Check for idempotency conflicts
   */
  private checkIdempotency(
    step: PlanStep,
    executionId: string,
    existingExecutions: Set<string>,
    stepIndex?: number
  ): SimulationFinding[] {
    const findings: SimulationFinding[] = [];
    const index = stepIndex ?? step.step_number ?? 0;

    // Generate idempotency key (simplified - in production use full hash)
    const idempotencyKey = `${executionId}:${step.id}:${step.tool_name}`;

    if (existingExecutions.has(idempotencyKey)) {
      findings.push({
        severity: "INFO",
        stepIndex: index,
        toolName: step.tool_name,
        category: "IDEMPOTENCY_CONFLICT",
        message: `Step would be skipped due to idempotency (already executed)`,
        suggestion: "This is expected behavior for retries",
      });
    }

    return findings;
  }

  /**
   * Check if tool is available
   */
  private checkToolAvailability(toolName: string): SimulationFinding[] {
    const findings: SimulationFinding[] = [];

    const tool = getTypedToolEntry(toolName as keyof AllToolsMap);
    
    if (!tool) {
      findings.push({
        severity: "CRITICAL",
        toolName,
        category: "RESOURCE_UNAVAILABLE",
        message: `Tool "${toolName}" is not registered`,
        suggestion: "Ensure tool is registered in MCP registry",
      });
    }

    return findings;
  }

  /**
   * Check for dependency conflicts in the plan
   */
  private checkDependencyConflicts(steps: PlanStep[]): SimulationFinding[] {
    const findings: SimulationFinding[] = [];

    // Build dependency graph
    const stepMap = new Map(steps.map((s, i) => [s.id, { step: s, index: i }]));

    for (const [stepId, { step, index }] of stepMap.entries()) {
      if (step.depends_on) {
        for (const depId of step.depends_on) {
          const depEntry = stepMap.get(depId);

          if (!depEntry) {
            findings.push({
              severity: "CRITICAL",
              stepIndex: index,
              toolName: step.tool_name,
              category: "DEPENDENCY_CONFLICT",
              message: `Step depends on "${depId}" which doesn't exist in plan`,
              suggestion: "Fix dependency references",
            });
          } else if (depEntry.index >= index) {
            findings.push({
              severity: "ERROR",
              stepIndex: index,
              toolName: step.tool_name,
              category: "DEPENDENCY_CONFLICT",
              message: `Step depends on "${depId}" which comes AFTER it in the plan`,
              suggestion: "Reorder steps to satisfy dependencies",
            });
          }
        }
      }
    }

    return findings;
  }

  /**
   * Estimate cost for a step (simplified)
   */
  private estimateStepCost(step: PlanStep): number {
    // Base cost per tool invocation (approximate)
    const BASE_COST = 0.002; // $0.002 per tool call
    
    // LLM-based tools cost more
    const isLlmTool = step.tool_name.toLowerCase().includes("llm") || 
                      step.tool_name.toLowerCase().includes("ai");
    
    const llmMultiplier = isLlmTool ? 5 : 1;
    
    // Parameter complexity adds cost
    const paramCount = Object.keys(step.parameters || {}).length;
    const complexityMultiplier = 1 + (paramCount * 0.1);
    
    return BASE_COST * llmMultiplier * complexityMultiplier;
  }

  /**
   * Estimate duration for a step (simplified)
   */
  private estimateStepDuration(step: PlanStep): number {
    // Base duration per tool (approximate)
    const BASE_DURATION_MS = 500;
    
    // LLM-based tools are slower
    const isLlmTool = step.tool_name.toLowerCase().includes("llm") || 
                      step.tool_name.toLowerCase().includes("ai");
    
    const llmMultiplier = isLlmTool ? 3 : 1;
    
    // External API calls are slower
    const isExternalApi = step.tool_name.toLowerCase().includes("external") ||
                          step.tool_name.toLowerCase().includes("api");
    
    const externalMultiplier = isExternalApi ? 2 : 1;
    
    return BASE_DURATION_MS * llmMultiplier * externalMultiplier;
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(
    totalSteps: number,
    validSteps: number,
    invalidSteps: number,
    wouldExecute: number,
    findings: SimulationFinding[],
    recommendation: string
  ): string {
    const parts = [
      `Simulation: ${validSteps}/${totalSteps} steps valid`,
      `${wouldExecute} would execute`,
    ];

    if (findings.length > 0) {
      const critical = findings.filter(f => f.severity === "CRITICAL").length;
      const errors = findings.filter(f => f.severity === "ERROR").length;
      const warnings = findings.filter(f => f.severity === "WARNING").length;

      if (critical > 0) parts.push(`${critical} critical issues`);
      if (errors > 0) parts.push(`${errors} errors`);
      if (warnings > 0) parts.push(`${warnings} warnings`);
    }

    parts.push(`Recommendation: ${recommendation.replace(/_/g, " ")}`);

    return parts.join(", ");
  }
}

// ============================================================================
// FACTORY
// ============================================================================

export function createDryRunSimulator(config?: SimulationConfig): DryRunSimulationService {
  return new DryRunSimulationService(config);
}
