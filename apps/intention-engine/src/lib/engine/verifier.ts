import { Plan, PlanStep } from "./types";

/**
 * SafetyPolicy defines the rules that a plan must adhere to.
 */
export interface SafetyPolicy {
  // Forbidden tool sequences. Use '*' for any tool.
  // Example: [['search', 'delete']] means a search followed by a delete is forbidden.
  forbiddenSequences: string[][];
  
  // Parameter limits for specific tools
  parameterLimits: Array<{
    tool: string;
    parameter: string;
    max?: number;
    min?: number;
  }>;

  // Context-based rules (optional, can be expanded)
  rules?: Array<{
    description: string;
    validate: (plan: Plan) => { valid: boolean; reason?: string };
  }>;
}

export interface VerificationResult {
  valid: boolean;
  reason?: string;
  violation?: string;
}

/**
 * Deterministic Verification Gate.
 * Validates a plan against a SafetyPolicy without using LLMs.
 */
export function verifyPlan(plan: Plan, policy: SafetyPolicy): VerificationResult {
  // 1. Validate parameter limits
  for (const step of plan.steps) {
    const limits = policy.parameterLimits.filter(l => l.tool === step.tool_name);
    for (const limit of limits) {
      const value = step.parameters[limit.parameter];
      if (typeof value === "number") {
        if (limit.max !== undefined && value > limit.max) {
          return {
            valid: false,
            reason: `Parameter limit exceeded: ${step.tool_name}.${limit.parameter} is ${value}, max is ${limit.max}`,
            violation: "PARAMETER_LIMIT_EXCEEDED",
          };
        }
        if (limit.min !== undefined && value < limit.min) {
          return {
            valid: false,
            reason: `Parameter limit violated: ${step.tool_name}.${limit.parameter} is ${value}, min is ${limit.min}`,
            violation: "PARAMETER_LIMIT_EXCEEDED",
          };
        }
      }
    }
  }

  // 2. Validate forbidden sequences
  // We need to check all paths in the DAG for forbidden sequences.
  // A sequence [A, B] is violated if there is a dependency A -> B.
  // More generally, [A, B] could mean A is executed before B in any path.
  
  // For simplicity and based on the requirement of "forbidden tool sequences", 
  // let's check direct dependencies first.
  for (const forbidden of policy.forbiddenSequences) {
    if (forbidden.length < 2) continue;

    for (const step of plan.steps) {
      if (matchTool(step.tool_name, forbidden[forbidden.length - 1])) {
        // Look back through dependencies
        if (checkSequence(plan, step, forbidden.slice(0, -1))) {
          return {
            valid: false,
            reason: `Forbidden sequence detected: ${forbidden.join(" -> ")}`,
            violation: "FORBIDDEN_SEQUENCE",
          };
        }
      }
    }
  }

  // 3. Custom rules
  if (policy.rules) {
    for (const rule of policy.rules) {
      const result = rule.validate(plan);
      if (!result.valid) {
        return {
          valid: false,
          reason: `Rule violation: ${rule.description}. ${result.reason || ""}`,
          violation: "RULE_VIOLATION",
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Recursively check if a sequence exists ending at the given step
 */
function checkSequence(plan: Plan, step: PlanStep, sequence: string[]): boolean {
  if (sequence.length === 0) return true;
  
  const targetTool = sequence[sequence.length - 1];
  
  for (const depId of step.dependencies) {
    const depStep = plan.steps.find(s => s.id === depId);
    if (depStep) {
      if (matchTool(depStep.tool_name, targetTool)) {
        if (checkSequence(plan, depStep, sequence.slice(0, -1))) {
          return true;
        }
      } else {
        // Continue searching up the tree? 
        // If the sequence is [A, B] and we have A -> X -> B, does it count?
        // Usually "sequence" implies direct or indirect dependency.
        // Let's assume indirect for safety.
        if (checkSequence(plan, depStep, sequence)) {
          return true;
        }
      }
    }
  }
  
  return false;
}

function matchTool(actual: string, pattern: string): boolean {
  if (pattern === "*") return true;
  return actual === pattern;
}

/**
 * Default Safety Policy for the engine.
 */
export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  forbiddenSequences: [
    ["search", "delete_account"], // Never allow automated deletion after search without filter
    ["*", "export_data"],         // Example: audit all data exports
  ],
  parameterLimits: [
    {
      tool: "reserve_table",
      parameter: "party_size",
      max: 20,
    },
    {
      tool: "schedule_meeting",
      parameter: "duration_minutes",
      max: 240, // 4 hours max
    }
  ],
};
