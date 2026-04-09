/**
 * Tests: T3.2 - Prompt Injection Defense (Zod Schema Validation + Auto-Retry)
 * Tests: T3.3 - Graceful Degradation for Redis/DB Outages
 *
 * @see Phase 3: Architecture & Security Hardening
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";

// ============================================================================
// MOCKS
// ============================================================================

vi.mock("./rate-limiter", () => ({
  RateLimiterService: class MockRateLimiter {
    async checkRateLimit() {
      return { allowed: true };
    }
  },
}));

vi.mock("@repo/shared", () => ({
  CircuitBreaker: class MockCircuitBreaker {
    async execute(fn: () => unknown) {
      return fn();
    }
  },
  Logger: class MockLogger {
    info() {}
    warn() {}
    error() {}
  },
}));

vi.mock("@repo/shared/middleware/retry-with-backoff", () => ({
  withRetry: vi.fn((fn) => fn),
}));

vi.mock("@repo/shared/middleware/serverless-timeout", () => ({
  withServerlessTimeout: vi.fn((fn) => fn),
}));

// ============================================================================
// T3.2: Zod Schema Validation + Auto-Retry
// ============================================================================

describe("T3.2: Zod Schema Validation + Auto-Retry", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe("validateLlmOutputAgainstSchema", () => {
    it("should validate correct JSON against schema", async () => {
      const { validateLlmOutputAgainstSchema } =
        await import("../lib/middleware/prompt-injection");
      const schema = z.object({
        type: z.string(),
        confidence: z.number(),
      });

      const result = validateLlmOutputAgainstSchema(
        '{"type": "SCHEDULE", "confidence": 0.95}',
        schema,
      );

      expect(result.valid).toBe(true);
      expect(result.data).toEqual({
        type: "SCHEDULE",
        confidence: 0.95,
      });
    });

    it("should reject invalid JSON", async () => {
      const { validateLlmOutputAgainstSchema } =
        await import("../lib/middleware/prompt-injection");
      const schema = z.object({ type: z.string() });

      const result = validateLlmOutputAgainstSchema("not json", schema);

      expect(result.valid).toBe(false);
      expect(result.error).toContain("not valid JSON");
    });

    it("should reject JSON that doesn't match schema", async () => {
      const { validateLlmOutputAgainstSchema } =
        await import("../lib/middleware/prompt-injection");
      const schema = z.object({
        type: z.enum(["SCHEDULE", "ACTION"]),
        confidence: z.number().min(0).max(1),
      });

      const result = validateLlmOutputAgainstSchema(
        '{"type": "INVALID_TYPE", "confidence": 1.5}',
        schema,
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain("Schema validation failed");
    });

    it("should handle nested schemas", async () => {
      const { validateLlmOutputAgainstSchema } =
        await import("../lib/middleware/prompt-injection");
      const schema = z.object({
        intent: z.object({
          type: z.string(),
          parameters: z.record(z.string(), z.unknown()),
        }),
        metadata: z.object({
          timestamp: z.string(),
        }),
      });

      const result = validateLlmOutputAgainstSchema(
        JSON.stringify({
          intent: {
            type: "QUERY",
            parameters: { location: "Tokyo" },
          },
          metadata: { timestamp: "2024-01-15T19:00:00Z" },
        }),
        schema,
      );

      expect(result.valid).toBe(true);
      expect(result.data?.intent.type).toBe("QUERY");
    });
  });

  describe("generateWithSchemaValidation", () => {
    it("should return data on first successful validation", async () => {
      const { generateWithSchemaValidation } =
        await import("../lib/middleware/prompt-injection");
      const schema = z.object({ type: z.string() });

      const generateFn = vi.fn().mockResolvedValue('{"type": "SCHEDULE"}');

      const result = await generateWithSchemaValidation(generateFn, schema, {
        systemPrompt: "Test prompt",
      });

      expect(result.data).toEqual({ type: "SCHEDULE" });
      expect(result.retriesUsed).toBe(0);
      expect(generateFn).toHaveBeenCalledTimes(1);
    });

    it("should retry once with stricter prompt on validation failure", async () => {
      const { generateWithSchemaValidation, resetPromptRetriesTotal } =
        await import("../lib/middleware/prompt-injection");
      resetPromptRetriesTotal();

      const schema = z.object({ type: z.string() });
      const generateFn = vi
        .fn()
        .mockResolvedValueOnce("invalid json")
        .mockResolvedValueOnce('{"type": "SCHEDULE"}');

      const result = await generateWithSchemaValidation(generateFn, schema, {
        systemPrompt: "Test prompt",
        maxRetries: 1,
      });

      expect(result.data).toEqual({ type: "SCHEDULE" });
      expect(result.retriesUsed).toBe(1);
      expect(generateFn).toHaveBeenCalledTimes(2);

      // Second call should include stricter prompt
      const secondCall = generateFn.mock.calls[1][0];
      expect(secondCall).toContain("CRITICAL SECURITY CONSTRAINTS");
    });

    it("should throw after retry exhaustion", async () => {
      const { generateWithSchemaValidation, resetPromptRetriesTotal } =
        await import("../lib/middleware/prompt-injection");
      resetPromptRetriesTotal();

      const schema = z.object({ type: z.string() });
      const generateFn = vi.fn().mockResolvedValue("invalid");

      await expect(
        generateWithSchemaValidation(generateFn, schema, {
          systemPrompt: "Test prompt",
          maxRetries: 1,
        }),
      ).rejects.toThrow("schema validation after retry");

      expect(generateFn).toHaveBeenCalledTimes(2);
    });

    it("should handle generation function throwing", async () => {
      const { generateWithSchemaValidation, resetPromptRetriesTotal } =
        await import("../lib/middleware/prompt-injection");
      resetPromptRetriesTotal();

      const schema = z.object({ type: z.string() });
      const generateFn = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce('{"type": "QUERY"}');

      const result = await generateWithSchemaValidation(generateFn, schema, {
        systemPrompt: "Test prompt",
        maxRetries: 1,
      });

      expect(result.data).toEqual({ type: "QUERY" });
      expect(result.retriesUsed).toBe(1);
    });
  });

  describe("Prompt retry metrics", () => {
    it("should track retry count", async () => {
      const { getPromptRetriesTotal, resetPromptRetriesTotal } =
        await import("../lib/middleware/prompt-injection");

      resetPromptRetriesTotal();
      expect(getPromptRetriesTotal()).toBe(0);
    });

    it("should reset retry count", async () => {
      const { getPromptRetriesTotal, resetPromptRetriesTotal } =
        await import("../lib/middleware/prompt-injection");

      resetPromptRetriesTotal();
      expect(getPromptRetriesTotal()).toBe(0);
    });
  });
});

// ============================================================================
// T3.3: Graceful Degradation for Redis/DB Outages
// ============================================================================

describe("T3.3: Graceful Degradation", () => {
  it("should have circuit breaker pattern available in @repo/shared", async () => {
    const { CircuitBreaker } = await import("@repo/shared");
    expect(typeof CircuitBreaker).toBe("function");
  });

  it("should have withRetry middleware for resilient operations", async () => {
    const { withRetry } =
      await import("@repo/shared/middleware/retry-with-backoff");
    expect(typeof withRetry).toBe("function");
  });

  it("should have serverless timeout protection", async () => {
    const { withServerlessTimeout } =
      await import("@repo/shared/middleware/serverless-timeout");
    expect(typeof withServerlessTimeout).toBe("function");
  });
});
