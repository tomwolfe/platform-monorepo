/**
 * Unit Tests: Planner Fan-Out Logic
 *
 * Tests for the planner's fan-out behavior when handling multi-value parameters.
 * Ensures that array parameters are correctly expanded into parallel execution steps.
 *
 * Coverage:
 * - Basic fan-out with single multi-value parameter
 * - Dependency preservation across fan-out steps
 * - Parameter distribution to fanned-out steps
 *
 * @see T5: Migrate Manual Scripts to Vitest
 */

import { describe, it, expect } from "vitest";
import { convertRawPlanToPlan, RawPlan } from "../planner.js";
import type { Intent, PlanConstraints, ToolDefinition } from "../types.js";
import { randomUUID } from "crypto";

describe("Planner Fan-Out Logic", () => {
  // Test fixtures
  const mockIntent: Intent = {
    id: randomUUID(),
    type: "QUERY",
    confidence: 0.98,
    parameters: { location: ["Tokyo", "London", "NY"] },
    rawText: "What is the weather in Tokyo, London, and NY?",
    explanation:
      "User is asking for weather information for multiple locations",
    metadata: {
      version: "1.0.0",
      timestamp: new Date().toISOString(),
      source: "user_input",
    },
    requires_clarification: false,
  };

  const mockConstraints: PlanConstraints = {
    max_steps: 10,
    max_total_tokens: 8000,
    max_execution_time_ms: 120000,
  };

  const weatherTool: ToolDefinition = {
    name: "get_weather",
    version: "1.0.0",
    description: "Get weather for a location",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "The city name" },
      },
      required: ["location"],
    },
    return_schema: {},
    category: "data",
    timeout_ms: 30000,
    requires_confirmation: false,
  };

  describe("Basic Fan-Out", () => {
    it("should fan-out single step with array parameter into multiple steps", () => {
      const rawPlan: RawPlan = {
        steps: [
          {
            step_number: 0,
            tool_name: "get_weather",
            parameters: { location: ["Tokyo", "London", "NY"] },
            dependencies: [],
            description: "Get weather for requested locations",
            requires_confirmation: false,
            estimated_tokens: 100,
          },
        ],
        summary: "Get weather for Tokyo, London, and NY",
        estimated_total_tokens: 300,
        estimated_latency_ms: 2000,
      };

      const plan = convertRawPlanToPlan(
        rawPlan,
        mockIntent,
        mockConstraints,
        "gpt-4o",
        [weatherTool],
      );

      // Should fan-out to 3 separate steps (one per location)
      expect(plan.steps).toHaveLength(3);

      // All locations should be present in the fanned-out steps
      const locations = plan.steps.map((s) => s.parameters.location);
      expect(locations).toContain("Tokyo");
      expect(locations).toContain("London");
      expect(locations).toContain("NY");
    });

    it("should preserve tool name and other metadata during fan-out", () => {
      const rawPlan: RawPlan = {
        steps: [
          {
            step_number: 0,
            tool_name: "get_weather",
            parameters: { location: ["Tokyo", "London"] },
            dependencies: [],
            description: "Get weather for requested locations",
            requires_confirmation: false,
            estimated_tokens: 100,
          },
        ],
        summary: "Get weather for Tokyo and London",
        estimated_total_tokens: 200,
        estimated_latency_ms: 1500,
      };

      const plan = convertRawPlanToPlan(
        rawPlan,
        mockIntent,
        mockConstraints,
        "gpt-4o",
        [weatherTool],
      );

      // All fanned-out steps should use the same tool
      plan.steps.forEach((step) => {
        expect(step.tool_name).toBe("get_weather");
        expect(step.requires_confirmation).toBe(false);
      });
    });
  });

  describe("Dependencies with Fan-Out", () => {
    it("should correctly update dependencies when fan-out occurs", () => {
      const rawPlan: RawPlan = {
        steps: [
          {
            step_number: 0,
            tool_name: "get_weather",
            parameters: { location: ["Tokyo", "London"] },
            dependencies: [],
            description: "Get weather",
            requires_confirmation: false,
            estimated_tokens: 100,
          },
          {
            step_number: 1,
            tool_name: "log",
            parameters: { message: "Weather retrieved" },
            dependencies: [0],
            description: "Log completion",
            requires_confirmation: false,
            estimated_tokens: 50,
          },
        ],
        summary: "Get weather and log",
        estimated_total_tokens: 250,
        estimated_latency_ms: 2000,
      };

      const plan = convertRawPlanToPlan(
        rawPlan,
        mockIntent,
        mockConstraints,
        "gpt-4o",
        [weatherTool],
      );

      // Should have 3 steps: 2 weather + 1 log
      expect(plan.steps).toHaveLength(3);

      // Find the log step
      const logStep = plan.steps.find((s) => s.tool_name === "log");
      expect(logStep).toBeDefined();

      // Find the weather step IDs
      const weatherStepIds = plan.steps
        .filter((s) => s.tool_name === "get_weather")
        .map((s) => s.id);

      // Log step should depend on BOTH weather steps
      expect(logStep?.dependencies).toHaveLength(2);
      weatherStepIds.forEach((id) => {
        expect(logStep?.dependencies).toContain(id);
      });
    });

    it("should handle fan-out with multiple dependency chains", () => {
      const rawPlan: RawPlan = {
        steps: [
          {
            step_number: 0,
            tool_name: "get_weather",
            parameters: { location: ["Tokyo"] },
            dependencies: [],
            description: "Get Tokyo weather",
            requires_confirmation: false,
            estimated_tokens: 100,
          },
          {
            step_number: 1,
            tool_name: "get_weather",
            parameters: { location: ["London", "NY"] },
            dependencies: [0],
            description: "Get other weather",
            requires_confirmation: false,
            estimated_tokens: 100,
          },
        ],
        summary: "Get weather sequentially",
        estimated_total_tokens: 300,
        estimated_latency_ms: 3000,
      };

      const plan = convertRawPlanToPlan(
        rawPlan,
        mockIntent,
        mockConstraints,
        "gpt-4o",
        [weatherTool],
      );

      // Should have 3 steps: 1 Tokyo + 2 (London, NY)
      expect(plan.steps).toHaveLength(3);

      // London and NY steps should depend on Tokyo step
      const tokyoStep = plan.steps.find(
        (s) => s.parameters.location === "Tokyo",
      );
      expect(tokyoStep).toBeDefined();

      const londonStep = plan.steps.find(
        (s) => s.parameters.location === "London",
      );
      const nyStep = plan.steps.find((s) => s.parameters.location === "NY");

      expect(londonStep?.dependencies).toContain(tokyoStep?.id);
      expect(nyStep?.dependencies).toContain(tokyoStep?.id);
    });
  });

  describe("Edge Cases", () => {
    it("should not fan-out when parameter is not an array", () => {
      const rawPlan: RawPlan = {
        steps: [
          {
            step_number: 0,
            tool_name: "get_weather",
            parameters: { location: "Tokyo" },
            dependencies: [],
            description: "Get weather for Tokyo",
            requires_confirmation: false,
            estimated_tokens: 100,
          },
        ],
        summary: "Get weather for Tokyo",
        estimated_total_tokens: 100,
        estimated_latency_ms: 1000,
      };

      const plan = convertRawPlanToPlan(
        rawPlan,
        mockIntent,
        mockConstraints,
        "gpt-4o",
        [weatherTool],
      );

      // Should remain as single step
      expect(plan.steps).toHaveLength(1);
      expect(plan.steps[0].parameters.location).toBe("Tokyo");
    });

    it("should handle empty array parameter gracefully", () => {
      const rawPlan: RawPlan = {
        steps: [
          {
            step_number: 0,
            tool_name: "get_weather",
            parameters: { location: [] },
            dependencies: [],
            description: "Get weather for no locations",
            requires_confirmation: false,
            estimated_tokens: 100,
          },
        ],
        summary: "Get weather for empty list",
        estimated_total_tokens: 0,
        estimated_latency_ms: 0,
      };

      const plan = convertRawPlanToPlan(
        rawPlan,
        mockIntent,
        mockConstraints,
        "gpt-4o",
        [weatherTool],
      );

      // Should produce zero steps for empty array
      expect(plan.steps).toHaveLength(0);
    });
  });
});
