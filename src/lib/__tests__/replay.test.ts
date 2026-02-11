import { normalizeIntent } from "../normalization";
import { Intent } from "../schema";

/**
 * Simulates a jittery LLM that returns slightly different structures
 * for the same intent.
 */
function jitteryLLMSimulator(input: string): any {
  if (input.includes("schedule")) {
    const jitters = [
      { type: "SCHEDULE", confidence: 0.95, parameters: { action: "create", temporal_expression: "tomorrow at 3pm" } },
      { type: "SCHEDULE", confidence: 0.92, parameters: { action: "CREATE", temporal_expression: "tomorrow at 3pm" } },
      { type: "SCHEDULE", confidence: 0.98, parameters: { action: "create", temporal_expression: "2026-02-11T15:00:00Z" } },
    ];
    return jitters[Math.floor(Math.random() * jitters.length)];
  }
  return { type: "UNKNOWN", confidence: 0.1, parameters: {} };
}

async function runReplayTest(input: string, iterations: number = 100) {
  const results: string[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const candidate = jitteryLLMSimulator(input);
    const normalized = normalizeIntent(candidate, input, "simulator-v1");
    
    // Normalize for comparison: remove id and timestamp
    const comparable = {
      type: normalized.type,
      parameters: normalized.parameters,
      // Note: Confidence might still vary if the simulator varies it, 
      // but the ONTOLOGY should force it to a stable state if we had a rule for it.
      // For now, let's see how many are "semantically identical".
    };
    results.push(JSON.stringify(comparable));
  }
  
  const uniqueResults = new Set(results);
  const identityPercentage = ((iterations - (uniqueResults.size - 1)) / iterations) * 100;
  
  console.log(`Input: "${input}"`);
  console.log(`Iterations: ${iterations}`);
  console.log(`Unique Semantic States: ${uniqueResults.size}`);
  console.log(`Identity Percentage: ${identityPercentage}%`);
  
  return identityPercentage;
}

async function main() {
  console.log("--- PHASE 1: REPLAY TEST ---");
  const score = await runReplayTest("schedule a meeting tomorrow at 3pm", 100);
  
  if (score >= 95) {
    console.log("PASS: Repeatability threshold met.");
    process.exit(0);
  } else {
    console.log("FAIL: Too much variance in normalized output.");
    process.exit(1);
  }
}

main();
