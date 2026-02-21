import type { Intent } from "./schema";

export interface IntentHypotheses {
  primary: Intent;
  alternatives: Intent[];
  isAmbiguous: boolean;
  clarificationQuestion?: string;
}

const CONFIDENCE_THRESHOLD = 0.85;
const AMBIGUITY_GAP = 0.15;

/**
 * Evaluates a set of normalized intents to determine if there is a clear winner
 * or if the situation is ambiguous.
 */
export function resolveAmbiguity(intents: Intent[]): IntentHypotheses {
  if (intents.length === 0) {
    throw new Error("No intents provided for resolution");
  }

  // Sort by confidence descending
  const sorted = [...intents].sort((a, b) => b.confidence - a.confidence);
  const primary = sorted[0];
  const alternatives = sorted.slice(1);

  let isAmbiguous = false;
  let clarificationQuestion: string | undefined;

  // Rule 1: Low Absolute Confidence
  if (primary.confidence < CONFIDENCE_THRESHOLD) {
    isAmbiguous = true;
    clarificationQuestion = primary.explanation || "I'm not sure what you want to do. Could you clarify?";
  }

  // Rule 2: Narrow Gap between Top 2
  if (alternatives.length > 0 && (primary.confidence - alternatives[0].confidence) < AMBIGUITY_GAP) {
    isAmbiguous = true;
    clarificationQuestion = `I'm torn between ${primary.type} and ${alternatives[0].type}. Which did you mean?`;
  }

  // Rule 3: Explicit SERVICE_DEGRADED or UNKNOWN
  if (primary.type === "SERVICE_DEGRADED" || primary.type === "UNKNOWN") {
    isAmbiguous = true;
    clarificationQuestion = "I cannot perform this request as stated.";
  }

  if (isAmbiguous) {
    primary.type = "CLARIFICATION_REQUIRED";
  }

  return {
    primary,
    alternatives,
    isAmbiguous,
    clarificationQuestion
  };
}
