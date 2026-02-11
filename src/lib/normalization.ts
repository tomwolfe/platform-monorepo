import { Intent, IntentSchema, IntentType } from "./schema";
import { validateIntentParams } from "./resolveAmbiguity";

/**
 * Normalizes a candidate intent from an LLM.
 * 1. Validates against Zod schema.
 * 2. Cross-references with Ontology requirements.
 * 3. Adjusts confidence deterministically.
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
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      source: "user_input",
      model_id: modelId,
    }
  });

  if (!parsed.success) {
    // If it doesn't even match the schema, it's UNKNOWN or REFUSED
    return createFallbackIntent(rawText, "UNKNOWN", "Schema validation failed", modelId);
  }

  const intent = parsed.data;

  // 2. Ontology parameter check
  const { isValid, missingFields } = validateIntentParams(intent.type, intent.parameters);

  if (!isValid) {
    // Return CLARIFICATION_REQUIRED if parameters are missing
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

  // 3. Category specific normalization
  if (intent.type === "SCHEDULE") {
     // Ensure action is uppercase
     if (intent.parameters.action) {
       intent.parameters.action = intent.parameters.action.toUpperCase();
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
