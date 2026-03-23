import { describe, it, expect } from "vitest";
import { normalizeIntent } from "../normalization";

/**
 * Simulates a jittery LLM that returns slightly different structures
 * for the same intent.
 */
function jitteryLLMSimulator(input: string): any {
  if (input.includes("schedule")) {
    const jitters = [
      {
        type: "SCHEDULE",
        confidence: 0.95,
        parameters: { action: "create", temporal_expression: "tomorrow at 3pm" },
      },
      {
        type: "SCHEDULE",
        confidence: 0.92,
        parameters: { action: "CREATE", temporal_expression: "tomorrow at 3pm" },
      },
      {
        type: "SCHEDULE",
        confidence: 0.98,
        parameters: { action: "create", temporal_expression: "2026-02-11T15:00:00Z" },
      },
    ];
    return jitters[Math.floor(Math.random() * jitters.length)];
  }
  return { type: "UNKNOWN", confidence: 0.1, parameters: {} };
}

describe("Intent Replay & Semantic Stability", () => {
  it("should maintain semantic identity across multiple normalizations", () => {
    const input = "schedule a meeting tomorrow at 3pm";
    const iterations = 100;
    const results: string[] = [];

    for (let i = 0; i < iterations; i++) {
      const candidate = jitteryLLMSimulator(input);
      const normalized = normalizeIntent(candidate, input, "simulator-v1");

      // Normalize for comparison: remove id and timestamp
      const comparable = {
        type: normalized.type,
        parameters: normalized.parameters,
      };
      results.push(JSON.stringify(comparable));
    }

    const uniqueResults = new Set(results);
    const identityPercentage =
      ((iterations - (uniqueResults.size - 1)) / iterations) * 100;

    // Expect at least 95% semantic identity
    expect(identityPercentage).toBeGreaterThanOrEqual(95);
  });
});
