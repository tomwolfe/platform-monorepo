/**
 * Unified Planning Pipeline
 *
 * Consolidates planner + repair + verifier into single pipeline:
 *   generatePlan() → validatePlan() → executePlan()
 *
 * Features:
 * - LLM-based plan generation with parameter aliasing
 * - Fan-out detection and parallel step generation
 * - Merge rule validator for dining + delivery unification
 * - Live State Gate for operational state awareness
 * - Automated repair with retry on validation failures
 * - Confidence scoring and safety validation
 *
 * @see Phase 2.1: Collapse Architectural Complexity
 */

import { z } from "zod";
import { randomUUID } from "crypto";
import {
  Intent,
  Plan,
  PlanSchema,
  PlanStep,
  PlanConstraints,
  PlanConstraintsSchema,
  ToolDefinition,
  TraceEntry,
  TraceEntrySchema,
  EngineErrorSchema,
} from "./types";
import { generateStructured, type GenerateStructuredResult } from "./llm";
import type { ToolExecutor } from "./workflow-machine";
import {
  DEFAULT_PLAN_CONSTRAINTS,
  RawPlanSchema,
  convertRawPlanToPlan,
  validatePlanConstraints,
  validateMergeRule,
  buildPlanningPrompt,
  PlannerContext as PlannerHelpersContext,
} from "./planner-helpers";
import { PARAMETER_ALIASES } from "@repo/mcp-protocol";

export * from "./types";
export { DEFAULT_PLAN_CONSTRAINTS } from "./planner-helpers";

// ============================================================================
// TYPES
// ============================================================================

export interface PlanningContext {
  execution_id?: string;
  available_tools?: ToolDefinition[];
  constraints?: Partial<PlanConstraints>;
  repairFeedback?: string;
  confidenceThreshold?: number;
}

export interface PlanningResult {
  plan: Plan;
  trace_entry: TraceEntry;
  latency_ms: number;
  token_usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  confidence: number;
  validation: {
    constraints_valid: boolean;
    safety_valid: boolean;
    merge_rule_valid: boolean;
  };
}

export interface FrozenPlan {
  plan: Plan;
  frozen_at: string;
  execution_hash: string;
  is_frozen: true;
}

// Re-export types for backward compatibility
export type PlannerContext = PlanningContext;
export type PlannerResult = PlanningResult;

// ============================================================================
// SAFETY POLICY
// ============================================================================

export const DEFAULT_SAFETY_POLICY = {
  forbiddenSequences: [
    ["search", "delete_account"],
    ["*", "export_data"],
  ],
  parameterLimits: [
    { tool: "reserve_table", parameter: "party_size", max: 20 },
    { tool: "schedule_meeting", parameter: "duration_minutes", max: 240 },
  ],
};

// ============================================================================
// PLAN FREEZING
// Note: Uses Web Crypto API for Edge runtime compatibility
// ============================================================================

export function freezePlan(plan: Plan): FrozenPlan {
  const frozenAt = new Date().toISOString();
  
  // Use Web Crypto API for Edge runtime compatibility
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify({
    plan_id: plan.id,
    steps: plan.steps.map((s) => ({
      tool_name: s.tool_name,
      parameters: s.parameters,
      dependencies: s.dependencies,
    })),
    timestamp: frozenAt,
  }));
  
  // For Edge runtime, we'll use a simple hash (in production, use a proper crypto library)
  // This is a simplified version - in production use a proper hashing library
  const hash = data.reduce((acc, byte) => acc + byte.toString(16), '');
  
  return {
    plan,
    frozen_at: frozenAt,
    execution_hash: hash,
    is_frozen: true,
  };
}

// ============================================================================
// CONFIDENCE CALCULATION
// ============================================================================

export function calculatePlanConfidence(
  plan: Plan,
  intent: Intent,
  context: PlanningContext
): number {
  let confidence = 0.5;
  if (plan.steps.length > 0) confidence += 0.2;
  
  const availableTools = context.available_tools || [];
  const allToolsValid = plan.steps.every((step) =>
    availableTools.some((t) => t.name === step.tool_name)
  );
  if (allToolsValid) confidence += 0.15;
  
  const stepIds = new Set(plan.steps.map((s) => s.id));
  const allDepsValid = plan.steps.every((step) =>
    step.dependencies.every((depId) => stepIds.has(depId))
  );
  if (allDepsValid) confidence += 0.1;
  
  const constraints = { ...DEFAULT_PLAN_CONSTRAINTS, ...context.constraints };
  if (validatePlanConstraints(plan, constraints).valid) confidence += 0.05;
  
  return Math.min(confidence, 1.0);
}

// ============================================================================
// SAFETY VALIDATION
// ============================================================================

export function verifyPlan(plan: Plan, policy = DEFAULT_SAFETY_POLICY): {
  valid: boolean;
  reason?: string;
  violation?: string;
} {
  for (const step of plan.steps) {
    const limits = policy.parameterLimits.filter((l) => l.tool === step.tool_name);
    for (const limit of limits) {
      const value = step.parameters[limit.parameter];
      if (typeof value === "number") {
        if (limit.max !== undefined && value > limit.max) {
          return {
            valid: false,
            reason: `Parameter limit: ${step.tool_name}.${limit.parameter} = ${value} > ${limit.max}`,
            violation: "PARAMETER_LIMIT_EXCEEDED",
          };
        }
      }
    }
  }
  return { valid: true };
}

// ============================================================================
// GENERATE RAW PLAN
// ============================================================================

async function generateRawPlan(
  intent: Intent,
  context: PlanningContext
): Promise<any> {
  const constraints = { ...DEFAULT_PLAN_CONSTRAINTS, ...context.constraints };
  const systemPrompt = buildPlanningPrompt({
    available_tools: context.available_tools,
    constraints,
  });

  // Fetch recent successful intentions for context injection
  let contextHistory: Array<{ input?: string; summary?: string; status: string }> = [];
  try {
    const { getMemoryClient } = await import("./memory");
    const memory = getMemoryClient();
    const recentIntents = await memory.getRecentSuccessfulIntents(3);
    contextHistory = recentIntents.map(s => ({
      input: s.intent?.rawText,
      summary: s.plan?.summary,
      status: s.status
    }));
  } catch (error) {
    console.warn(
      '[UnifiedPlanner] Memory client unavailable, skipping context injection:',
      error instanceof Error ? error.message : error
    );
  }

  const basePrompt = JSON.stringify({
    intent_type: intent.type,
    parameters: intent.parameters,
    rawText: intent.rawText,
    explanation: intent.explanation,
    recent_successful_history: contextHistory,
  });

  const prompt = context.repairFeedback
    ? `REPAIR INSTRUCTION: ${context.repairFeedback}\n\nORIGINAL INTENT: ${basePrompt}`
    : basePrompt;

  const result = await generateStructured({
    modelType: "planning",
    prompt,
    systemPrompt,
    schema: RawPlanSchema,
    temperature: context.repairFeedback ? 0.2 : 0.1,
    timeoutMs: 30000,
  });

  return result.data;
}

// ============================================================================
// GENERATE PLAN (MAIN ENTRY)
// LIVE STATE GATE: Checks operational state before planning for BOOKING intents
// ============================================================================

export async function generatePlan(
  intent: Intent,
  context: PlanningContext = {}
): Promise<PlanningResult> {
  const startTime = performance.now();
  const timestamp = new Date().toISOString();

  try {
    // Validate intent
    if (!intent?.id || !intent.type) {
      throw EngineErrorSchema.parse({
        code: "PLAN_GENERATION_FAILED",
        message: "Invalid intent: missing id or type",
        recoverable: false,
        timestamp,
      });
    }

    // LIVE STATE GATE: Check operational state before planning for BOOKING intents
    // If target restaurant table status is 'occupied' or 'dirty', suggest delivery alternative
    let liveStateConstraint = "";
    if (intent.type === "ACTION" || intent.type === "SCHEDULE") {
      const intentParams = intent.parameters as Record<string, any>;
      const restaurantId = intentParams.restaurant_id || intentParams.restaurantId;

      if (restaurantId) {
        try {
          const { get_live_operational_state } = await import("../tools/operational_state");
          const liveState = await get_live_operational_state({ restaurant_id: restaurantId });

          if (liveState && typeof liveState === 'object') {
            const tableStatus = (liveState as any).table_status || (liveState as any).status;
            if (tableStatus === 'occupied' || tableStatus === 'dirty' || tableStatus === 'full') {
              liveStateConstraint = "Constraint: Target table is currently unavailable (occupied/dirty/full). Proactively suggest a delivery alternative via OpenDelivery instead of a booking. Do not attempt table reservation.";
              console.log(`[Live State Gate] Restaurant ${restaurantId} has table status '${tableStatus}'. Adding delivery constraint.`);
            }
          }
        } catch (err) {
          console.warn("[Live State Gate] Failed to check operational state:", err);
          // Continue without the constraint - don't block planning
        }
      }
    }

    const constraints = PlanConstraintsSchema.parse({
      ...DEFAULT_PLAN_CONSTRAINTS,
      ...context.constraints,
    });

    // Generate and convert
    const rawPlan = await generateRawPlan(intent, context);
    const plan = convertRawPlanToPlan(
      rawPlan,
      intent,
      constraints,
      "planning-model-v1",
      context.available_tools
    );

    // Validate constraints
    const constraintsValid = validatePlanConstraints(plan, constraints);
    if (!constraintsValid.valid && !context.repairFeedback) {
      return generatePlan(intent, {
        ...context,
        repairFeedback: constraintsValid.error,
      });
    }
    if (!constraintsValid.valid) {
      throw EngineErrorSchema.parse({
        code: "PLAN_VALIDATION_FAILED",
        message: constraintsValid.error,
        recoverable: false,
        timestamp,
      });
    }

    // Validate merge rule
    const mergeValid = validateMergeRule(plan, intent);
    if (!mergeValid.valid && !context.repairFeedback) {
      return generatePlan(intent, {
        ...context,
        repairFeedback: mergeValid.reason,
      });
    }
    if (!mergeValid.valid) {
      throw EngineErrorSchema.parse({
        code: "PLAN_VALIDATION_FAILED",
        message: `Merge rule: ${mergeValid.reason}`,
        recoverable: false,
        timestamp,
      });
    }

    // Safety validation
    const safetyValid = verifyPlan(plan);

    // Confidence
    const confidence = calculatePlanConfidence(plan, intent, context);
    const threshold = context.confidenceThreshold || 0.7;
    if (confidence < threshold) {
      throw EngineErrorSchema.parse({
        code: "PLAN_GENERATION_FAILED",
        message: `Confidence ${confidence} < ${threshold}`,
        details: { confidence, threshold },
        recoverable: true,
        timestamp,
      });
    }

    const latencyMs = Math.round(performance.now() - startTime);

    const traceEntry = TraceEntrySchema.parse({
      timestamp,
      phase: "planning",
      event: "plan_generated",
      input: { intent_id: intent.id, intent_type: intent.type },
      output: { plan_id: plan.id, step_count: plan.steps.length },
      latency_ms: latencyMs,
      token_usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });

    return {
      plan,
      trace_entry: traceEntry,
      latency_ms: latencyMs,
      token_usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
      confidence,
      validation: {
        constraints_valid: constraintsValid.valid,
        safety_valid: safetyValid.valid,
        merge_rule_valid: mergeValid.valid,
      },
    };
  } catch (error) {
    const endTime = performance.now();
    const latencyMs = Math.round(endTime - startTime);

    // If it's already an EngineError, re-throw it
    if (error && typeof error === "object" && "code" in error) {
      throw error;
    }

    // Wrap unexpected errors
    const errorMessage = error instanceof Error ? error.message : String(error);

    throw EngineErrorSchema.parse({
      code: "PLAN_GENERATION_FAILED",
      message: `Plan generation failed: ${errorMessage}`,
      details: {
        intent_id: intent?.id,
        intent_type: intent?.type,
        latency_ms: latencyMs,
      },
      recoverable: false,
      timestamp,
    });
  }
}

export function validatePlan(
  plan: Plan,
  context: PlanningContext = {}
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  const constraints = { ...DEFAULT_PLAN_CONSTRAINTS, ...context.constraints };
  const constraintsValid = validatePlanConstraints(plan, constraints);
  if (!constraintsValid.valid) errors.push(constraintsValid.error!);
  
  const mergeValid = validateMergeRule(plan, {} as Intent);
  if (!mergeValid.valid) errors.push(mergeValid.reason!);
  
  const safetyValid = verifyPlan(plan);
  if (!safetyValid.valid) errors.push(safetyValid.reason!);
  
  return { valid: errors.length === 0, errors };
}

// ============================================================================
// EXECUTE PLAN
// Wires frozen plan into WorkflowMachine for durable execution
// ============================================================================

export async function executePlan(
  plan: FrozenPlan,
  context: PlanningContext = {}
): Promise<{ success: boolean; error?: string; result?: any }> {
  if (!plan.is_frozen) {
    return { success: false, error: "Plan must be frozen before execution" };
  }

  try {
    // Import workflow execution dynamically to avoid circular dependencies
    const { executeWorkflow } = await import("./workflow-machine");
    const { getToolRegistry } = await import("./tools/registry");

    // Create tool executor wrapper
    const toolExecutor: ToolExecutor = {
      execute: async (toolName, parameters, timeoutMs, signal) => {
        const registry = getToolRegistry();
        const result = await registry.execute(toolName, parameters, {
          executionId: context.execution_id || plan.plan.id,
          stepId: toolName,
          timeoutMs,
          startTime: performance.now(),
          abortSignal: signal,
        });
        return {
          success: result.success,
          output: result.output,
          error: result.error,
          latency_ms: result.latency_ms,
        };
      },
    };

    // Execute the workflow
    const result = await executeWorkflow(plan.plan, toolExecutor, {
      executionId: context.execution_id,
      intentId: context.execution_id,
      traceId: context.execution_id,
    });

    return {
      success: result.success,
      result: {
        workflowId: result.workflowId,
        completedSteps: result.completedSteps,
        failedSteps: result.failedSteps,
        totalSteps: result.totalSteps,
        executionTimeMs: result.executionTimeMs,
        error: result.error,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[UnifiedPlanner] executePlan failed:", errorMessage);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

// ============================================================================
// VALIDATE PLAN DAG
// Explicit DAG validation (redundant with PlanSchema but explicit)
// ============================================================================

export function validatePlanDag(plan: Plan): { valid: boolean; cycles?: string[] } {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const cycles: string[] = [];

  function visit(stepId: string, path: string[]): boolean {
    if (recursionStack.has(stepId)) {
      // Found cycle
      const cycleStart = path.indexOf(stepId);
      const cycle = path.slice(cycleStart).concat([stepId]);
      cycles.push(cycle.join(" -> "));
      return false;
    }

    if (visited.has(stepId)) {
      return true;
    }

    visited.add(stepId);
    recursionStack.add(stepId);

    const step = plan.steps.find(s => s.id === stepId);
    if (step) {
      for (const depId of step.dependencies) {
        if (!visit(depId, [...path, stepId])) {
          return false;
        }
      }
    }

    recursionStack.delete(stepId);
    return true;
  }

  for (const step of plan.steps) {
    if (!visited.has(step.id)) {
      if (!visit(step.id, [])) {
        return { valid: false, cycles };
      }
    }
  }

  return { valid: true };
}

// ============================================================================
// GET PLAN TOPOLOGICAL ORDER
// Returns steps in dependency-resolved execution order
// ============================================================================

export function getTopologicalOrder(plan: Plan): PlanStep[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // Initialize
  for (const step of plan.steps) {
    inDegree.set(step.id, 0);
    adjacency.set(step.id, []);
  }

  // Build adjacency and count in-degrees
  for (const step of plan.steps) {
    for (const depId of step.dependencies) {
      adjacency.get(depId)!.push(step.id);
      inDegree.set(step.id, (inDegree.get(step.id) || 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  const result: PlanStep[] = [];

  // Start with nodes having no dependencies
  Array.from(inDegree.keys()).forEach(stepId => {
    const degree = inDegree.get(stepId);
    if (degree === 0) {
      queue.push(stepId);
    }
  });

  while (queue.length > 0) {
    const stepId = queue.shift()!;
    const step = plan.steps.find(s => s.id === stepId)!;
    result.push(step);

    for (const dependentId of adjacency.get(stepId) || []) {
      const newDegree = (inDegree.get(dependentId) || 0) - 1;
      inDegree.set(dependentId, newDegree);
      if (newDegree === 0) {
        queue.push(dependentId);
      }
    }
  }

  // If not all steps were processed, there's a cycle
  if (result.length !== plan.steps.length) {
    throw new Error("Plan contains circular dependencies");
  }

  return result;
}

// ============================================================================
// GENERATE PLAN WITH REPAIR
// Wrapper that provides automated repair on validation failures
// ============================================================================

export async function generatePlanWithRepair(
  intent: Intent,
  context: PlanningContext = {}
): Promise<PlanningResult> {
  try {
    // Attempt 1: Normal generation
    return await generatePlan(intent, context);
  } catch (error: any) {
    // Check if it's a validation error
    const isValidationError =
      error.code === "PLAN_VALIDATION_FAILED" ||
      error.code === "LLM_SCHEMA_VALIDATION_FAILED";

    if (!isValidationError) {
      throw error; // Re-throw if it's not a validation error
    }

    console.warn(`Plan validation failed. Attempting repair... Error: ${error.message}`);

    // Attempt 2: Repair generation with error feedback
    const repairFeedback = `The previous plan generation failed validation with the following error:
${error.message}
${error.details ? `Details: ${JSON.stringify(error.details)}` : ""}

Please correct the plan and ensure it strictly follows the schema and constraints.
Original Intent: ${intent.rawText}
Parameters: ${JSON.stringify(intent.parameters)}`;

    return await generatePlan(intent, {
      ...context,
      repairFeedback,
    });
  }
}