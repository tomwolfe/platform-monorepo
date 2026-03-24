import { describe, it, expect, vi } from "vitest";
import { executePlan, type ToolExecutor } from "../engine/unified-planner";
import type { Plan } from "../engine/types";
import { randomUUID } from "crypto";

describe("Parallel Execution", () => {
  it("should execute independent steps in parallel", async () => {
    const mockToolExecutor: ToolExecutor = {
      execute: async (name, params, timeout) => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { success: true, output: { result: "ok" }, latency_ms: 1000 };
      },
    };

    const plan: Plan = {
      id: randomUUID(),
      intent_id: randomUUID(),
      steps: [
        {
          id: randomUUID(),
          step_number: 0,
          tool_name: "tool1",
          parameters: {},
          dependencies: [],
          description: "Independent 1",
          requires_confirmation: false,
          timeout_ms: 5000,
        },
        {
          id: randomUUID(),
          step_number: 1,
          tool_name: "tool2",
          parameters: {},
          dependencies: [],
          description: "Independent 2",
          requires_confirmation: false,
          timeout_ms: 5000,
        },
      ],
      constraints: {
        max_steps: 10,
        max_total_tokens: 1000,
        max_execution_time_ms: 10000,
      },
      metadata: {
        version: "1.0.0",
        created_at: new Date().toISOString(),
        planning_model_id: "test",
        estimated_total_tokens: 0,
        estimated_latency_ms: 0,
      },
      summary: "Parallel test plan",
    };

    const startTime = Date.now();
    await executePlan(plan, mockToolExecutor, { persistState: false });
    const totalDuration = Date.now() - startTime;

    // tool1 and tool2 should run in parallel, so they should both finish around 1000ms.
    // If they ran serially, it would be 2000ms+.
    expect(totalDuration).toBeLessThan(1500);
  });

  it("should execute dependent steps sequentially", async () => {
    const executionOrder: string[] = [];
    const mockToolExecutor: ToolExecutor = {
      execute: async (name, params, timeout) => {
        executionOrder.push(name);
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { success: true, output: { result: "ok" }, latency_ms: 500 };
      },
    };

    const step1Id = randomUUID();
    const step2Id = randomUUID();

    const plan: Plan = {
      id: randomUUID(),
      intent_id: randomUUID(),
      steps: [
        {
          id: step1Id,
          step_number: 0,
          tool_name: "tool1",
          parameters: {},
          dependencies: [],
          description: "First step",
          requires_confirmation: false,
          timeout_ms: 5000,
        },
        {
          id: step2Id,
          step_number: 1,
          tool_name: "tool2",
          parameters: {},
          dependencies: [step1Id], // Depends on step 1
          description: "Second step (depends on first)",
          requires_confirmation: false,
          timeout_ms: 5000,
        },
      ],
      constraints: {
        max_steps: 10,
        max_total_tokens: 1000,
        max_execution_time_ms: 10000,
      },
      metadata: {
        version: "1.0.0",
        created_at: new Date().toISOString(),
        planning_model_id: "test",
        estimated_total_tokens: 0,
        estimated_latency_ms: 0,
      },
      summary: "Sequential test plan",
    };

    await executePlan(plan, mockToolExecutor, { persistState: false });

    // Verify execution order respects dependencies
    expect(executionOrder).toEqual(["tool1", "tool2"]);
  });
});
