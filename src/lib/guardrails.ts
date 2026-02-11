import { Intent } from "./schema";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface CapabilityGuardrail {
  capability: string;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  description: string;
}

const CAPABILITY_GUARDRAILS: Record<string, CapabilityGuardrail> = {
  "calendar.create": {
    capability: "calendar.create",
    riskLevel: "LOW",
    requiresConfirmation: false,
    description: "Creating a calendar event."
  },
  "calendar.delete": {
    capability: "calendar.delete",
    riskLevel: "HIGH",
    requiresConfirmation: true,
    description: "Deleting a calendar event."
  },
  "email.send": {
    capability: "email.send",
    riskLevel: "MEDIUM",
    requiresConfirmation: true,
    description: "Sending an email."
  }
};

/**
 * Checks if an intent violates safety guardrails or requires confirmation.
 */
export function checkGuardrails(intent: Intent): { 
  allowed: boolean; 
  requiresConfirmation: boolean; 
  reason?: string; 
} {
  if (intent.type !== "ACTION") {
    return { allowed: true, requiresConfirmation: false };
  }

  const capability = intent.parameters.capability;
  const guardrail = CAPABILITY_GUARDRAILS[capability];

  if (!guardrail) {
    return { 
      allowed: false, 
      requiresConfirmation: false, 
      reason: `Unknown capability: ${capability}` 
    };
  }

  return {
    allowed: true,
    requiresConfirmation: guardrail.requiresConfirmation,
    reason: guardrail.description
  };
}
