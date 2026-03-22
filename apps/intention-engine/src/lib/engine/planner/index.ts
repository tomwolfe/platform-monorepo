/**
 * Planner Module - Unified Intent-to-Plan Pipeline
 * 
 * Main API:
 * ```typescript
 * import { generatePlan, verifyPlan } from '@/lib/engine/planner';
 * 
 * const plan = await generatePlan(intent);
 * const verification = verifyPlan(plan, DEFAULT_SAFETY_POLICY);
 * ```
 * 
 * Pipeline:
 * 1. generatePlan() - LLM generates plan from intent
 * 2. verifyPlan() - Deterministic safety validation  
 * 3. generatePlanWithRepair() - Auto-retry on validation failure
 * 
 * @module @/lib/engine/planner
 */

// Main planning functions (from parent directory)
export { 
  generatePlan,
  generatePlan as executeIntent, // Alias for unified API
  convertRawPlanToPlan,
  validatePlanDag,
  getTopologicalOrder,
  DEFAULT_PLAN_CONSTRAINTS,
} from '../planner';

export type {
  PlannerResult,
  PlannerContext,
  RawPlanStep,
  RawPlan,
} from '../planner';

// Verification (from parent directory)
export { 
  verifyPlan, 
  DEFAULT_SAFETY_POLICY,
} from '../verifier';

export type { 
  SafetyPolicy, 
  VerificationResult 
} from '../verifier';

// Repair middleware (from parent directory)
export { 
  generatePlanWithRepair,
} from '../planner-repair';
