/**
 * Unified Planning Pipeline
 * 
 * Consolidates planner + repair + verifier into single pipeline:
 *   generatePlan() → validatePlan() → executePlan()
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
import { generateStructured } from "./llm";
import {
  DEFAULT_PLAN_CONSTRAINTS,
  RawPlanSchema,
  convertRawPlanToPlan,
  validatePlanConstraints,
  validateMergeRule,
  buildPlanningPrompt,
  PlannerContext as PlannerHelpersContext,
} from "./planner-helpers";

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
// ============================================================================

export function freezePlan(plan: Plan): FrozenPlan {
  const crypto = require("crypto");
  const frozenAt = new Date().toISOString();
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify({
    plan_id: plan.id,
    steps: plan.steps.map((s) => ({
      tool_name: s.tool_name,
      parameters: s.parameters,
      dependencies: s.dependencies,
    })),
    timestamp: frozenAt,
  }));
  
  return {
    plan,
    frozen_at: frozenAt,
    execution_hash: hash.digest("hex"),
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

  const contextHistory: Array<{ input?: string; summary?: string; status: string }> = [];
  
  const basePrompt = JSON.stringify({
    intent_type: intent.type,
    parameters: intent.parameters,
    rawText: intent.rawText,
    explanation: intent.explanation,
    recent_successful_history: contextHistory,
  });

  const prompt = context.repairFeedback
    ? `REPAIR: ${context.repairFeedback}\n\nORIGINAL: ${basePrompt}`
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
// ============================================================================

export async function generatePlan(
  intent: Intent,
  context: PlanningContext = {}
): Promise<PlanningResult> {
  const startTime = performance.now();
  const timestamp = new Date().toISOString();

  if (!intent?.id || !intent.type) {
    throw EngineErrorSchema.parse({
      code: "PLAN_GENERATION_FAILED",
      message: "Invalid intent: missing id or type",
      recoverable: false,
      timestamp,
    });
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
}

// ============================================================================
// VALIDATE PLAN (exported for pipeline)
// ============================================================================

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
// EXECUTE PLAN (stub for pipeline)
// ============================================================================

export async function executePlan(
  plan: FrozenPlan,
  context: PlanningContext = {}
): Promise<{ success: boolean; error?: string }> {
  // Stub - actual execution happens in engine
  if (!plan.is_frozen) {
    return { success: false, error: "Plan must be frozen before execution" };
  }
  return { success: true };
}