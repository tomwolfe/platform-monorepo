import { describe, it, expect } from "vitest";
import { normalizeIntent } from "../normalization";
import { resolveAmbiguity } from "../ambiguity";

/**
 * Simulates an LLM responding to ambiguous input.
 */
function ambiguousLLMSimulator(input: string): any[] {
  if (input === "book it") {
    return [
      {
        type: "ACTION",
        confidence: 0.5,
        parameters: { capability: "booking", arguments: {} },
        explanation: "Assuming you want to book a flight.",
      },
      {
        type: "SCHEDULE",
        confidence: 0.45,
        parameters: { action: "create", temporal_expression: "now" },
        explanation: "Assuming you want to add a book to your schedule.",
      },
    ];
  }
  if (input === "ghghghgh") {
    return [
      { type: "UNKNOWN", confidence: 0.1, parameters: {}, explanation: "This is gibberish." },
    ];
  }
  return [
    { type: "SEARCH", confidence: 0.9, parameters: { query: input, scope: "GLOBAL" } },
  ];
}

describe("Ambiguity Resolution", () => {
  it("should detect ambiguity for multiple close hypotheses", () => {
    const input = "book it";
    const candidates = ambiguousLLMSimulator(input);
    const normalized = candidates.map((c) =>
      normalizeIntent(c, input, "sim-v1")
    );
    const result = resolveAmbiguity(normalized);

    expect(result.isAmbiguous).toBe(true);
    expect(result.primary.type).toBe("CLARIFICATION_REQUIRED");
    expect(result.clarificationQuestion).toBeDefined();
  });

  it("should detect low confidence for gibberish input", () => {
    const input = "ghghghgh";
    const candidates = ambiguousLLMSimulator(input);
    const normalized = candidates.map((c) =>
      normalizeIntent(c, input, "sim-v1")
    );
    const result = resolveAmbiguity(normalized);

    expect(result.isAmbiguous).toBe(true);
    expect(result.primary.type).toBe("CLARIFICATION_REQUIRED");
  });
});
