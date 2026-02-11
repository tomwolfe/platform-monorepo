import { Intent } from "./schema";
import { normalizeIntent } from "./normalization";

/**
 * Supersedes an existing intent with a new interpretation (e.g., after clarification).
 * This maintains the link to the parent for traceability.
 */
export function supersedeIntent(
  parentIntent: Intent,
  newRawText: string,
  newCandidate: any,
  modelId: string
): Intent {
  const normalized = normalizeIntent(newCandidate, newRawText, modelId);
  
  return {
    ...normalized,
    parent_intent_id: parentIntent.id,
    metadata: {
      ...normalized.metadata,
      source: `superseded_from_${parentIntent.id}`
    }
  };
}

/**
 * Revokes an intent, marking it as invalid for further action.
 */
export function revokeIntent(intent: Intent, reason: string): Intent {
  return {
    ...intent,
    type: "REFUSED",
    explanation: `REVOKED: ${reason}. Original: ${intent.explanation}`,
    confidence: 0,
    metadata: {
      ...intent.metadata,
      timestamp: new Date().toISOString()
    }
  };
}
