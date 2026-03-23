/**
 * Planner Helpers
 *
 * Shared utilities for plan generation. Extracted from planner.ts
 * for use by unified-planner.ts
 *
 * @see Phase 2.1: Consolidate planner layers
 */

import { z } from "zod";
import {
  Intent,
  Plan,
  PlanSchema,
  PlanStep,
  PlanStepSchema,
  PlanConstraints,
  PlanMetadataSchema,
  ToolDefinition,
  EngineErrorSchema,
} from "./types";
import { PARAMETER_ALIASES } from "@repo/mcp-protocol";

/**
 * Generate a random UUID (Edge runtime compatible)
 */
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ============================================================================
// DEFAULT CONSTRAINTS
// ============================================================================

export const DEFAULT_PLAN_CONSTRAINTS: PlanConstraints = {
  max_steps: 10,
  max_total_tokens: 8000,
  max_execution_time_ms: 120000,
};

// ============================================================================
// RAW PLAN SCHEMA
// ============================================================================

const RawPlanStepSchema = z.object({
  step_number: z.number().int().nonnegative(),
  tool_name: z.string(),
  tool_version: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()),
  dependencies: z.array(z.number().int().nonnegative()),
  description: z.string(),
  requires_confirmation: z.boolean(),
  estimated_tokens: z.number().int().nonnegative().optional(),
});

export const RawPlanSchema = z.object({
  steps: z.array(RawPlanStepSchema).min(1),
  summary: z.string(),
  estimated_total_tokens: z.number().int().nonnegative(),
  estimated_latency_ms: z.number().int().nonnegative(),
});

export type RawPlan = z.infer<typeof RawPlanSchema>;
export type RawPlanStep = z.infer<typeof RawPlanStepSchema>;

// ============================================================================
// PLANNER CONTEXT
// ============================================================================

export interface PlannerContext {
  execution_id?: string;
  available_tools?: ToolDefinition[];
  constraints?: Partial<PlanConstraints>;
  user_preferences?: Record<string, unknown>;
  repairFeedback?: string;
}

// ============================================================================
// BUILD PLANNING PROMPT
// ============================================================================

const PLANNING_PROMPT_TEMPLATE = `You are a planning system that converts user intents into executable step-by-step plans.

## Capability Statement
You are equipped with a suite of real-world tools. If a tool is listed in 'Available Tools', you HAVE the authority to use it.

## Task
Given a user intent, create a detailed execution plan with ordered steps.

## Rules
1. Steps must be ordered logically (dependencies must have lower step_number)
2. NO circular dependencies allowed
3. Max {max_steps} steps allowed
4. FAN-OUT: If the intent involves multiple entities, generate parallel steps
5. Strict Matching: Match cuisine tags explicitly
6. Estimate token usage for each step
7. Use requires_confirmation for irreversible actions

## MERGE RULE FOR UNIFIED INTENTS
**CRITICAL: If you detect BOTH a delivery request AND a reservation request for the same location/time, MERGE them into a unified plan.**

The delivery should arrive at or slightly before the reservation time.

## Available Tools
{available_tools}

## Output Format
Return JSON with: steps, summary, estimated_total_tokens, estimated_latency_ms`;

export function buildPlanningPrompt(context: PlannerContext): string {
  const constraints = { ...DEFAULT_PLAN_CONSTRAINTS, ...context.constraints };
  const toolList = context.available_tools?.length
    ? context.available_tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")
    : "NO_TOOLS_AVAILABLE";

  return PLANNING_PROMPT_TEMPLATE
    .replace("{max_steps}", String(constraints.max_steps))
    .replace("{available_tools}", toolList);
}

// ============================================================================
// PARAMETER ALIASING
// ============================================================================

function applyParameterAliases(
  parameters: Record<string, unknown>,
  toolName?: string
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...parameters };
  let aliasApplied = false;

  for (const [alias, primary] of Object.entries(PARAMETER_ALIASES)) {
    if (resolved[alias] !== undefined && resolved[primary] === undefined) {
      resolved[primary] = resolved[alias];
      delete resolved[alias];
      console.log(`[Planner] Applied alias: ${alias} -> ${primary} for ${toolName || "unknown"}`);
      aliasApplied = true;
    }
  }

  if (aliasApplied) {
    console.log(`[Planner] Alias resolution complete for ${toolName || "unknown"}`);
  }

  return resolved;
}

// ============================================================================
// CONVERT RAW PLAN TO CANONICAL PLAN
// ============================================================================

export function convertRawPlanToPlan(
  rawPlan: RawPlan,
  intent: Intent,
  constraints: PlanConstraints,
  modelId: string,
  availableTools: ToolDefinition[] = []
): Plan {
  const timestamp = new Date().toISOString();
  const expandedSteps: RawPlanStep[] = [];
  let nextStepNumber = 0;
  const originalToNewStepIds = new Map<number, number[]>();

  // Handle fan-out
  for (const rawStep of rawPlan.steps) {
    const toolDef = availableTools.find((t) => t.name === rawStep.tool_name);
    let fanOutParamKey: string | null = null;
    let fanOutValues: unknown[] | null = null;

    if (toolDef) {
      for (const [key, value] of Object.entries(rawStep.parameters)) {
        const propDef = toolDef.inputSchema.properties[key];
        if (propDef && Array.isArray(value) && ["string", "number", "boolean"].includes(propDef.type)) {
          fanOutParamKey = key;
          fanOutValues = value;
          break;
        }
      }
    }

    if (fanOutParamKey && fanOutValues && fanOutValues.length > 0) {
      const newStepNumbers: number[] = [];
      for (const value of fanOutValues) {
        const stepNum = nextStepNumber++;
        newStepNumbers.push(stepNum);
        expandedSteps.push({
          ...rawStep,
          step_number: stepNum,
          parameters: { ...rawStep.parameters, [fanOutParamKey]: value },
          description: `${rawStep.description} (${value})`,
        });
      }
      originalToNewStepIds.set(rawStep.step_number, newStepNumbers);
    } else {
      const stepNum = nextStepNumber++;
      originalToNewStepIds.set(rawStep.step_number, [stepNum]);
      expandedSteps.push({ ...rawStep, step_number: stepNum });
    }
  }

  // Update dependencies
  for (const step of expandedSteps) {
    const newDeps: number[] = [];
    for (const oldDepNum of step.dependencies) {
      const mappedNums = originalToNewStepIds.get(oldDepNum) || [];
      newDeps.push(...mappedNums);
    }
    step.dependencies = Array.from(new Set(newDeps));
  }

  // Create step ID mapping
  const stepIdMap = new Map<number, string>();
  for (const step of expandedSteps) {
    stepIdMap.set(step.step_number, generateUUID());
  }

  // Convert to canonical steps
  const steps: PlanStep[] = expandedSteps.map((rawStep) => {
    const dependencyUuids = rawStep.dependencies.map((depNum) => {
      const depId = stepIdMap.get(depNum);
      if (!depId) {
        throw new Error(`Invalid dependency: step ${rawStep.step_number} references non-existent step ${depNum}`);
      }
      return depId;
    });

    const normalizedParameters = applyParameterAliases(rawStep.parameters, rawStep.tool_name);

    return PlanStepSchema.parse({
      id: stepIdMap.get(rawStep.step_number)!,
      step_number: rawStep.step_number,
      tool_name: rawStep.tool_name,
      tool_version: rawStep.tool_version,
      parameters: normalizedParameters,
      dependencies: dependencyUuids,
      description: rawStep.description,
      requires_confirmation: rawStep.requires_confirmation,
      estimated_tokens: rawStep.estimated_tokens,
      timeout_ms: 30000,
    });
  });

  const totalEstimatedTokens = steps.reduce((sum, step) => sum + (step.estimated_tokens || 0), 0);

  return PlanSchema.parse({
    id: generateUUID(),
    intent_id: intent.id,
    steps,
    constraints,
    metadata: PlanMetadataSchema.parse({
      version: "1.0.0",
      created_at: timestamp,
      planning_model_id: modelId,
      estimated_total_tokens: totalEstimatedTokens,
      estimated_latency_ms: rawPlan.estimated_latency_ms,
    }),
    summary: rawPlan.summary,
  });
}

// ============================================================================
// VALIDATE PLAN CONSTRAINTS
// ============================================================================

export function validatePlanConstraints(
  plan: Plan,
  constraints: PlanConstraints
): { valid: boolean; error?: string } {
  if (plan.steps.length > constraints.max_steps) {
    return {
      valid: false,
      error: `Plan has ${plan.steps.length} steps, exceeds maximum of ${constraints.max_steps}`,
    };
  }

  const totalTokens = plan.steps.reduce((sum, step) => sum + (step.estimated_tokens || 0), 0);
  if (totalTokens > constraints.max_total_tokens) {
    return {
      valid: false,
      error: `Plan estimated tokens (${totalTokens}) exceeds budget (${constraints.max_total_tokens})`,
    };
  }

  return { valid: true };
}

// ============================================================================
// MERGE RULE VALIDATOR
// ============================================================================

export function validateMergeRule(
  plan: Plan,
  intent: Intent
): { valid: boolean; reason?: string } {
  const intentParams = intent.parameters as Record<string, any>;

  const deliveryTools = ["calculateQuote", "calculate_delivery_quote", "fulfill_intent", "dispatch_intent"];
  const reservationTools = ["reserve_restaurant", "reserve_table", "bookTable", "create_reservation"];

  const hasDeliveryElement =
    intentParams.delivery ||
    intentParams.delivery_address ||
    intentParams.delivery_item ||
    intent.rawText.toLowerCase().includes("deliver") ||
    intent.rawText.toLowerCase().includes("delivery");

  const hasDiningElement =
    intentParams.restaurant ||
    intentParams.restaurant_id ||
    intent.rawText.toLowerCase().includes("table") ||
    intent.rawText.toLowerCase().includes("reserve") ||
    intent.rawText.toLowerCase().includes("booking");

  const celebrationKeywords = ["celebration", "anniversary", "birthday", "proposal", "special occasion"];
  const hasCelebrationElement = celebrationKeywords.some((kw) =>
    intent.rawText.toLowerCase().includes(kw)
  );

  if (hasDeliveryElement && hasDiningElement) {
    const hasDeliveryStep = plan.steps.some((step) =>
      deliveryTools.some((tool) => step.tool_name.toLowerCase().includes(tool.toLowerCase()))
    );

    const hasReservationStep = plan.steps.some((step) =>
      reservationTools.some((tool) => step.tool_name.toLowerCase().includes(tool.toLowerCase()))
    );

    if (hasDeliveryStep && hasReservationStep) {
      const deliveryStep = plan.steps.find((step) =>
        deliveryTools.some((tool) => step.tool_name.toLowerCase().includes(tool.toLowerCase()))
      );

      const reservationStep = plan.steps.find((step) =>
        reservationTools.some((tool) => step.tool_name.toLowerCase().includes(tool.toLowerCase()))
      );

      if (deliveryStep && reservationStep) {
        const hasCoordination =
          deliveryStep.dependencies.includes(reservationStep.id) ||
          reservationStep.dependencies.includes(deliveryStep.id) ||
          deliveryStep.parameters.restaurant_id === reservationStep.parameters.restaurant_id ||
          deliveryStep.parameters.restaurantId === reservationStep.parameters.restaurantId;

        if (!hasCoordination) {
          return {
            valid: false,
            reason: "Delivery and reservation steps are not coordinated. Add dependencies or shared parameters.",
          };
        }
      }
    }

    if (hasCelebrationElement && (!hasDeliveryStep || !hasReservationStep)) {
      return {
        valid: false,
        reason: "Celebration intent detected. Create a unified plan with both reservation and delivery.",
      };
    }
  }

  const restaurantDeliveryPattern = /to the restaurant|at the restaurant|for when we arrive/i;
  if (restaurantDeliveryPattern.test(intent.rawText)) {
    const hasDeliveryStep = plan.steps.some((step) =>
      deliveryTools.some((tool) => step.tool_name.toLowerCase().includes(tool.toLowerCase()))
    );

    if (!hasDeliveryStep) {
      return {
        valid: false,
        reason: "User requested delivery 'to the restaurant' but plan has no delivery step.",
      };
    }
  }

  return { valid: true };
}
