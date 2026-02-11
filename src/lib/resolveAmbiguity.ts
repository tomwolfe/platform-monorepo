import type { IntentType } from "./schema";

export const REQUIRED_FIELDS_MAP: Record<string, string[]> = {
  SCHEDULE: ["action", "temporal_expression"],
  SEARCH: ["query", "scope"],
  ACTION: ["capability", "arguments"],
  QUERY: ["target_object"],
  PLANNING: ["goal"],
  ANALYSIS: ["context"],
};

/**
 * Validates that an intent has all required parameters.
 */
export function validateIntentParams(intentType: string, params: Record<string, any>) {
  const requiredFields = REQUIRED_FIELDS_MAP[intentType] || [];
  const missingFields = requiredFields.filter(field => {
    const value = params[field];
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
  });
  
  return {
    isValid: missingFields.length === 0,
    missingFields
  };
}
