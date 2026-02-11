import { IntentSchema } from "./schema";
import type { Intent, IntentType } from "./schema";
import { validateIntentParams, REQUIRED_FIELDS_MAP } from "./resolveAmbiguity";

/**
 * Normalizes a candidate intent from an LLM.
 * 1. Validates against Zod schema.
 * 2. Cross-references with Ontology requirements.
 * 3. Adjusts confidence deterministically.
 * 4. Ensures Chain-of-Thought consistency.
 */
export function normalizeIntent(
  candidate: any,
  rawText: string,
  modelId: string
): Intent {
  // 1. Basic validation
  const parsed = IntentSchema.safeParse({
    ...candidate,
    id: candidate.id || crypto.randomUUID(),
    rawText: rawText,
    metadata: {
      version: "1.1.0",
      timestamp: new Date().toISOString(),
      source: "user_input",
      model_id: modelId,
    }
  });

  if (!parsed.success) {
    return createFallbackIntent(rawText, "UNKNOWN", "Schema validation failed", modelId);
  }

  const intent = parsed.data;

  // 2. Parameter Hardening: Strip unmapped parameters to enforce Schema Invariance
  const allowedFields = REQUIRED_FIELDS_MAP[intent.type] || [];
  const hardenedParams: Record<string, any> = {};
  for (const field of allowedFields) {
    if (intent.parameters[field] !== undefined) {
      hardenedParams[field] = intent.parameters[field];
    }
  }
  intent.parameters = hardenedParams;

  // 3. Ontology parameter check
  const { isValid, missingFields } = validateIntentParams(intent.type, intent.parameters);

  if (!isValid) {
    return {
      ...intent,
      type: "CLARIFICATION_REQUIRED",
      confidence: 0.5,
      parameters: {
        ...intent.parameters,
        missingFields
      },
      explanation: `Missing required fields: ${missingFields.join(", ")}`
    };
  }

  // 4. Chain-of-Thought (CoT) Consistency Verification
  if (intent.explanation) {
    const cot = intent.explanation.toUpperCase();
    const otherTypes = (Object.keys(REQUIRED_FIELDS_MAP) as IntentType[]).filter(t => t !== intent.type);
    
    for (const otherType of otherTypes) {
      // If the CoT mentions mapping to a different type than the one selected, penalize confidence.
      if (cot.includes(`MATCH: ${otherType}`) || cot.includes(`ONTOLOGY: ${otherType}`)) {
        intent.confidence *= 0.7; // Significant penalty for internal inconsistency
        intent.explanation += ` [Consistency Alert: CoT suggests ${otherType} but result is ${intent.type}]`;
      }
    }
  }

  // 5. Category specific normalization (Deterministic)
  if (intent.type === "SCHEDULE") {
     if (typeof intent.parameters.action === 'string') {
       let action = intent.parameters.action.toUpperCase();
       // Verb Collapsing: Map synonyms to canonical roots
       if (["BOOK", "SET UP", "ARRANGE", "ORGANIZE", "SETUP"].includes(action)) {
         action = "SCHEDULE";
       }
       intent.parameters.action = action;
     }
  }

  return intent;
}

function createFallbackIntent(
  rawText: string,
  type: IntentType,
  explanation: string,
  modelId: string
): Intent {
  return {
    id: crypto.randomUUID(),
    type,
    confidence: 0,
    parameters: {},
    rawText,
    explanation,
    metadata: {
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      source: "system_fallback",
      model_id: modelId,
    }
  };
}
