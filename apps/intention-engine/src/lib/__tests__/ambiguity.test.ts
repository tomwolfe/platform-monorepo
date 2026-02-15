import { normalizeIntent } from "../normalization";
import { resolveAmbiguity } from "../ambiguity";

/**
 * Simulates an LLM responding to ambiguous input.
 */
function ambiguousLLMSimulator(input: string): any[] {
  if (input === "book it") {
    return [
      { type: "ACTION", confidence: 0.5, parameters: { capability: "booking", arguments: {} }, explanation: "Assuming you want to book a flight." },
      { type: "SCHEDULE", confidence: 0.45, parameters: { action: "create", temporal_expression: "now" }, explanation: "Assuming you want to add a book to your schedule." }
    ];
  }
  if (input === "ghghghgh") {
    return [
      { type: "UNKNOWN", confidence: 0.1, parameters: {}, explanation: "This is gibberish." }
    ];
  }
  return [{ type: "SEARCH", confidence: 0.9, parameters: { query: input, scope: "GLOBAL" } }];
}

async function runAmbiguityTest() {
  console.log("--- PHASE 2: AMBIGUITY TEST ---");

  // Test Case 1: Multiple close hypotheses
  const input1 = "book it";
  const candidates1 = ambiguousLLMSimulator(input1);
  const normalized1 = candidates1.map(c => normalizeIntent(c, input1, "sim-v1"));
  const result1 = resolveAmbiguity(normalized1);
  
  console.log(`Input: "${input1}"`);
  console.log(`Primary Type: ${result1.primary.type}`);
  console.log(`Is Ambiguous: ${result1.isAmbiguous}`);
  console.log(`Question: ${result1.clarificationQuestion}`);

  if (!result1.isAmbiguous || result1.primary.type !== "CLARIFICATION_REQUIRED") {
    console.error("FAIL: Should have detected ambiguity for 'book it'");
    process.exit(1);
  }

  // Test Case 2: Gibberish (Low confidence)
  const input2 = "ghghghgh";
  const candidates2 = ambiguousLLMSimulator(input2);
  const normalized2 = candidates2.map(c => normalizeIntent(c, input2, "sim-v1"));
  const result2 = resolveAmbiguity(normalized2);

  console.log(`Input: "${input2}"`);
  console.log(`Primary Type: ${result2.primary.type}`);
  console.log(`Is Ambiguous: ${result2.isAmbiguous}`);

  if (!result2.isAmbiguous || result2.primary.type !== "CLARIFICATION_REQUIRED") {
    console.error("FAIL: Should have detected low confidence for gibberish");
    process.exit(1);
  }

  console.log("PASS: Ambiguity successfully surfaced.");
}

runAmbiguityTest();
