import { describe, it, expect } from "vitest";
import { normalizeIntent } from "../normalization";
import { supersedeIntent, revokeIntent } from "../lifecycle";

describe("Intent Lifecycle Management", () => {
  const modelId = "sim-v1";

  it("should maintain parent link when superseding intent", () => {
    const raw1 = "book it";
    const candidate1 = {
      type: "CLARIFICATION_REQUIRED" as const,
      confidence: 0.5,
      parameters: {},
      explanation: "Ambiguous",
    };
    const intent1 = normalizeIntent(candidate1, raw1, modelId);

    // Simulate user clarifying: "I mean book a flight"
    const raw2 = "I mean book a flight";
    const candidate2 = {
      type: "ACTION" as const,
      confidence: 0.9,
      parameters: { capability: "flight_booking", arguments: {} },
    };
    const intent2 = supersedeIntent(intent1, raw2, candidate2, modelId);

    expect(intent2.parent_intent_id).toBe(intent1.id);
    expect(intent2.metadata.source).toContain(`superseded_from_${intent1.id}`);
  });

  it("should reset state correctly when revoking intent", () => {
    const raw = "book it";
    const candidate = {
      type: "ACTION" as const,
      confidence: 0.9,
      parameters: { capability: "flight_booking", arguments: {} },
    };
    const intent = normalizeIntent(candidate, raw, modelId);

    const revoked = revokeIntent(intent, "User cancelled");

    expect(revoked.type).toBe("SERVICE_DEGRADED");
    expect(revoked.confidence).toBe(0);
    expect(revoked.explanation).toContain("REVOKED: User cancelled");
  });
});
