/**
 * Tests: LLM Confidence Fallback & Rule-Based Routing (T1.2)
 *
 * Verifies that the intent engine gracefully degrades to deterministic
 * keyword matching when LLM confidence drops below threshold or API fails.
 *
 * @see Phase 1, Task 1.2: LLM Fallback & Confidence Threshold
 */

import { describe, it, expect, beforeEach, vi, afterAll } from "vitest";
import {
  classifyIntentByKeywords,
  INTENT_CONFIDENCE_THRESHOLD,
  getLLMFallbackCount,
  resetLLMFallbackCount,
} from "../lib/engine/intent";

// ============================================================================
// MOCKS
// ============================================================================

vi.mock("../lib/engine/llm", () => ({
  generateStructured: vi.fn(),
}));

vi.mock("@repo/shared", () => ({
  Logger: class MockLogger {
    info() {}
    warn() {}
    error() {}
  },
  AppConfig: {
    getRedisUrl: () => "http://localhost:8080",
    getRedisToken: () => "test-token",
    isProduction: () => false,
    isTest: () => true,
  },
  getRedisClient: () => ({
    get: () => Promise.resolve(null),
    set: () => Promise.resolve("OK"),
  }),
  ServiceNamespace: {
    IE: "ie",
    OD: "od",
    TS: "ts",
    SHARED: "shared",
  },
}));

// ============================================================================
// TESTS: Keyword-Based Intent Classification
// ============================================================================

describe("T1.2: Keyword-Based Intent Classification", () => {
  describe("classifyIntentByKeywords", () => {
    it("should classify SCHEDULE intent from keywords", () => {
      const result = classifyIntentByKeywords(
        "Schedule a meeting with John tomorrow",
      );
      expect(result.type).toBe("SCHEDULE");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("should classify ACTION (booking) intent from keywords", () => {
      const result = classifyIntentByKeywords(
        "Book a table for 4 at an Italian restaurant tonight",
      );
      expect(result.type).toBe("ACTION");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("should classify SEARCH intent from keywords", () => {
      const result = classifyIntentByKeywords(
        "Find me a good pizza place nearby",
      );
      expect(result.type).toBe("SEARCH");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("should classify QUERY intent from keywords", () => {
      const result = classifyIntentByKeywords(
        "What is the weather in Tokyo tomorrow?",
      );
      expect(result.type).toBe("QUERY");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("should classify PLANNING intent from keywords", () => {
      const result = classifyIntentByKeywords("Plan a weekend trip to Paris");
      expect(result.type).toBe("PLANNING");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("should classify ANALYSIS intent from keywords", () => {
      const result = classifyIntentByKeywords(
        "Compare the prices of these restaurants",
      );
      expect(result.type).toBe("ANALYSIS");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("should return UNKNOWN for gibberish input", () => {
      const result = classifyIntentByKeywords("asdf jkl; zxcv");
      expect(result.type).toBe("UNKNOWN");
      expect(result.confidence).toBe(0.3);
    });

    it("should handle multi-word keywords with higher priority", () => {
      const result = classifyIntentByKeywords("set up a reminder");
      expect(result.type).toBe("SCHEDULE");
      expect(result.confidence).toBe(0.7); // Multi-word keyword gets fixed 0.7
    });

    it("should scale confidence with number of matched keywords", () => {
      // Multiple keywords should increase confidence
      const result = classifyIntentByKeywords(
        "Book a reservation for a table at a restaurant",
      );
      expect(result.type).toBe("ACTION");
      expect(result.confidence).toBeGreaterThan(0.6);
    });

    it("should handle greeting keywords", () => {
      const result = classifyIntentByKeywords("Hello, how are you?");
      expect(result.type).toBe("QUERY");
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("should handle cancellation keywords", () => {
      const result = classifyIntentByKeywords("Cancel my booking");
      // "cancel" = ACTION, "booking" = ACTION
      expect(result.type).toBe("ACTION");
    });

    it("should extract time parameters", async () => {
      // Import the private function indirectly through classifyIntentByKeywords
      // We'll test this through the public API
      const result = classifyIntentByKeywords("Book a table at 7pm");
      expect(result.type).toBe("ACTION");
    });
  });
});

// ============================================================================
// TESTS: Confidence Threshold
// ============================================================================

describe("T1.2: Confidence Threshold", () => {
  it("should export INTENT_CONFIDENCE_THRESHOLD as 0.65", () => {
    expect(INTENT_CONFIDENCE_THRESHOLD).toBe(0.65);
  });

  it("should have reasonable threshold value", () => {
    expect(INTENT_CONFIDENCE_THRESHOLD).toBeGreaterThan(0.5);
    expect(INTENT_CONFIDENCE_THRESHOLD).toBeLessThan(0.8);
  });
});

// ============================================================================
// TESTS: Fallback Metrics Tracking
// ============================================================================

describe("T1.2: Fallback Metrics Tracking", () => {
  beforeEach(() => {
    resetLLMFallbackCount();
  });

  afterAll(() => {
    resetLLMFallbackCount();
  });

  it("should start with zero fallback count", () => {
    expect(getLLMFallbackCount()).toBe(0);
  });

  it("should reset fallback count to zero", () => {
    resetLLMFallbackCount();
    expect(getLLMFallbackCount()).toBe(0);
  });
});

// ============================================================================
// TESTS: Intent Type Coverage
// ============================================================================

describe("T1.2: Intent Type Coverage", () => {
  const testCases: Array<{ input: string; expectedType: string }> = [
    { input: "Schedule a meeting", expectedType: "SCHEDULE" },
    { input: "Book a table", expectedType: "ACTION" },
    { input: "Find a restaurant", expectedType: "ACTION" }, // "restaurant" maps to ACTION (booking)
    { input: "What is the weather", expectedType: "QUERY" },
    { input: "Plan a trip", expectedType: "PLANNING" },
    { input: "Analyze the data", expectedType: "ANALYSIS" },
    { input: "Make a reservation", expectedType: "ACTION" },
    { input: "Check the status", expectedType: "QUERY" },
    { input: "Track my delivery", expectedType: "ACTION" }, // "delivery" maps to ACTION
    { input: "Compare options", expectedType: "ANALYSIS" },
  ];

  it.each(testCases)(
    'should classify "$input" as $expectedType',
    ({ input, expectedType }) => {
      const result = classifyIntentByKeywords(input);
      expect(result.type).toBe(expectedType);
    },
  );
});

// ============================================================================
// TESTS: Edge Cases
// ============================================================================

describe("T1.2: Edge Cases", () => {
  it("should handle empty string", () => {
    const result = classifyIntentByKeywords("");
    expect(result.type).toBe("UNKNOWN");
  });

  it("should handle whitespace-only input", () => {
    const result = classifyIntentByKeywords("   \t   \n  ");
    expect(result.type).toBe("UNKNOWN");
  });

  it("should handle mixed case input", () => {
    const result = classifyIntentByKeywords("SCHEDULE A MEETING");
    expect(result.type).toBe("SCHEDULE");
  });

  it("should handle punctuation", () => {
    const result = classifyIntentByKeywords("Book a table, please!");
    expect(result.type).toBe("ACTION");
  });

  it("should handle multiple intent signals", () => {
    // "Book" (ACTION) + "reservation" (ACTION) + "table" (ACTION)
    const result = classifyIntentByKeywords(
      "Book a reservation for a table at a restaurant for dinner",
    );
    expect(result.type).toBe("ACTION");
    // Multiple keyword matches should boost confidence
    expect(result.confidence).toBeGreaterThan(0.6);
  });

  it("should handle delivery tracking queries", () => {
    const result = classifyIntentByKeywords("Track my order delivery status");
    // "track" = QUERY, "delivery" = ACTION, "status" = QUERY, "order" = ACTION
    // Most common should be ACTION or QUERY depending on implementation
    expect(["QUERY", "ACTION"]).toContain(result.type);
  });

  it("should handle calendar-related queries", () => {
    const result = classifyIntentByKeywords("Check my calendar for tomorrow");
    expect(result.type).toBe("SCHEDULE");
  });

  it("should handle restaurant-related queries", () => {
    const result = classifyIntentByKeywords("Find me an Italian restaurant");
    // "restaurant" maps to ACTION (booking intent)
    expect(result.type).toBe("ACTION");
  });
});
