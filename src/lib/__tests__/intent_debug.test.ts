import { normalizeIntent } from "../normalization";

function debugIntent() {
  const rawText = "Schedule a meeting";
  const modelId = "debug-model";
  
  const candidate = {
    type: "schedule", // lowercase!
    confidence: 0.9,
    parameters: { action: "SCHEDULE", temporal_expression: "tomorrow" },
    explanation: "Lowercase type test"
  };

  console.log("Candidate with lowercase type:", JSON.stringify(candidate, null, 2));
  const normalized = normalizeIntent(candidate, rawText, modelId);
  console.log("Result Type:", normalized.type);
  console.log("Result Confidence:", normalized.confidence);
  console.log("Result Explanation:", normalized.explanation);
}

debugIntent();
