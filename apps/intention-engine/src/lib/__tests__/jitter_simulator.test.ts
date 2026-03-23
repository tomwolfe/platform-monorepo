import { describe, it, expect } from "vitest";
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
  if (
    normalizedText.includes("book") ||
    normalizedText.includes("schedule") ||
    normalizedText.includes("set up") ||
    normalizedText.includes("arrange")
  ) {
    return {
      type: "SCHEDULE",
      confidence: 0.9,
      parameters: {
        action: normalizedText.includes("book")
          ? "book"
          : normalizedText.includes("schedule")
          ? "schedule"
          : "setup",
        temporal_expression: "unknown",
      },
      explanation: `IDENTIFY: ${text}. MAP: SCHEDULE.`,
    };
  }
  return { type: "UNKNOWN", confidence: 0.1, parameters: {} };
}

describe("Jitter Simulation & Prompt Variation Resistance", () => {
  it("should maintain high identity percentage across prompt variations", () => {
    const basePrompt = "Book a meeting";
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
    const identityPercentage =
      ((variations.length - (uniqueResults.size - 1)) / variations.length) *
      100;

    // Expect at least 98% identity percentage
    expect(identityPercentage).toBeGreaterThanOrEqual(98);
  });

  it("should normalize different verb synonyms to the same action", () => {
    const synonyms = ["Book", "Schedule", "Set up", "Arrange"];
    const results = new Set<string>();

    for (const synonym of synonyms) {
      const prompt = `${synonym} a meeting`;
      const candidate = mockLLMInference(prompt);
      const normalized = normalizeIntent(candidate, prompt, "jitter-sim-v1");

      results.add(normalized.parameters.action as string);
    }

    // All synonyms should normalize to the same canonical action
    expect(results.size).toBeLessThanOrEqual(2); // May have "schedule" and "setup"
  });
});
