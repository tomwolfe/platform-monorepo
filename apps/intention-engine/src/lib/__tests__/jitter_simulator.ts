import { normalizeIntent } from "../normalization";
import { resolveAmbiguity } from "../ambiguity";
import type { Intent } from "../schema";

/**
 * Intentionally perturbs a prompt to simulate LLM jitter and user variation.
 */
export function perturbPrompt(text: string): string[] {
  const perturbations = [
    text, // Original
    text.toLowerCase(),
    text.toUpperCase(),
    text.replace(/a /g, "one "),
    text.replace(/Book/g, "Schedule"),
    text.replace(/Book/g, "Set up"),
    text.replace(/Book/g, "Arrange"),
    `Hey, could you please ${text.charAt(0).toLowerCase() + text.slice(1)}?`,
    `${text} right now.`,
    `I'd like to ${text.charAt(0).toLowerCase() + text.slice(1)}.`,
  ];
  return Array.from(new Set(perturbations));
}

/**
 * Simplified simulator that maps specific keywords to candidate objects.
 * This mimics the "CandidateSchema" output from the LLM.
 */
function mockLLMInference(text: string): any {
  const normalizedText = text.toLowerCase();
  if (normalizedText.includes("book") || normalizedText.includes("schedule") || normalizedText.includes("set up") || normalizedText.includes("arrange")) {
    return {
      type: "SCHEDULE",
      confidence: 0.9,
      parameters: {
        action: normalizedText.includes("book") ? "book" : (normalizedText.includes("schedule") ? "schedule" : "setup"),
        temporal_expression: "unknown"
      },
      explanation: `IDENTIFY: ${text}. MAP: SCHEDULE.`
    };
  }
  return { type: "UNKNOWN", confidence: 0.1, parameters: {} };
}

async function runJitterSimulation(basePrompt: string) {
  console.log(`--- JITTER SIMULATION: "${basePrompt}" ---`);
  const variations = perturbPrompt(basePrompt);
  const results: string[] = [];

  for (const variant of variations) {
    const candidate = mockLLMInference(variant);
    const normalized = normalizeIntent(candidate, variant, "jitter-sim-v1");
    
    const comparable = {
      type: normalized.type,
      parameters: normalized.parameters,
    };
    results.push(JSON.stringify(comparable));
  }

  const uniqueResults = new Set(results);
  const identityPercentage = ((variations.length - (uniqueResults.size - 1)) / variations.length) * 100;

  console.log(`Variations: ${variations.length}`);
  console.log(`Unique States: ${uniqueResults.size}`);
  console.log(`Identity Percentage: ${identityPercentage.toFixed(2)}%`);
  
  if (identityPercentage < 98) {
    console.error("FAIL: Jitter resistance below 98%");
    // console.log("Unique Results:", Array.from(uniqueResults));
  } else {
    console.log("PASS: High jitter resistance achieved.");
  }
}

async function main() {
  await runJitterSimulation("Book a meeting");
}

main();
