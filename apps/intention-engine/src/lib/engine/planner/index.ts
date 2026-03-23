/**
 * Planner Module - Unified Intent-to-Plan Pipeline
 *
 * Main API:
 * ```typescript
 * import { generatePlan, verifyPlan, generatePlanWithRepair } from '@/lib/engine/planner';
 *
 * const plan = await generatePlan(intent);
 * const verification = verifyPlan(plan, DEFAULT_SAFETY_POLICY);
 * const repairedPlan = await generatePlanWithRepair(intent);
 * ```
 *
 * @module @/lib/engine/planner
 * @see Phase 2.1: Consolidated into unified-planner.ts
 */

// Re-export everything from unified-planner.ts
export {
  generatePlan,
  generatePlan as executeIntent, // Alias for unified API
  generatePlanWithRepair,
  validatePlan,
  validatePlanDag,
  getTopologicalOrder,
  executePlan,
  freezePlan,
  verifyPlan,
  calculatePlanConfidence,
  DEFAULT_PLAN_CONSTRAINTS,
  DEFAULT_SAFETY_POLICY,
} from '../unified-planner';

export type {
  PlanningContext,
  PlannerContext, // Alias for backward compatibility
  PlanningResult,
  PlannerResult, // Alias for backward compatibility
  FrozenPlan,
} from '../unified-planner';

// Re-export types from types.ts
export type {
  Intent,
  Plan,
  PlanStep,
  PlanConstraints,
  ToolDefinition,
  TraceEntry,
} from '../types';
