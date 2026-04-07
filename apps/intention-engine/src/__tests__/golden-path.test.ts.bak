/**
 * Golden Path E2E Test - Restaurant Booking Flow
 * 
 * Tests the canonical execution path:
 * User Input → Intent → Plan → Verify → Execute → Result
 * 
 * This is the PRIMARY test for system reliability.
 * All other tests are secondary to this flow.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";

// Mock Redis to avoid requiring a live instance
vi.mock("@/lib/redis-client", () => ({
  redis: {
    keys: vi.fn().mockResolvedValue([]),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    setex: vi.fn().mockResolvedValue("OK"),
    scan: vi.fn().mockResolvedValue([]),
    hset: vi.fn().mockResolvedValue(1),
    hget: vi.fn().mockResolvedValue(null),
    hgetall: vi.fn().mockResolvedValue({}),
    expire: vi.fn().mockResolvedValue(1),
  },
}));

// Mock @repo/shared redis to avoid module not found errors
vi.mock("@repo/shared", async () => {
  const actual = await vi.importActual("@repo/shared");
  return {
    ...actual,
    getRedisClient: vi.fn(() => ({
      keys: vi.fn().mockResolvedValue([]),
      del: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      setex: vi.fn().mockResolvedValue("OK"),
      scan: vi.fn().mockResolvedValue([]),
      hset: vi.fn().mockResolvedValue(1),
      hget: vi.fn().mockResolvedValue(null),
      hgetall: vi.fn().mockResolvedValue({}),
      expire: vi.fn().mockResolvedValue(1),
    })),
    ServiceNamespace: {
      IE: 'ie',
      CACHE: 'cache',
      SHARED: 'shared',
    },
  };
});

import { parseIntent } from "@/lib/engine/intent";
import { generatePlan, DEFAULT_SAFETY_POLICY } from "@/lib/engine/unified-planner";
import { verifyPlan } from "@/lib/engine/verifier";
import { WorkflowMachine } from "@/lib/engine/workflow-machine";
import { loadExecutionState } from "@/lib/engine/memory";

import { getRedisClient, ServiceNamespace } from "@repo/shared";
const redis = getRedisClient(ServiceNamespace.IE);;

// ============================================================================
// MOCK TOOL EXECUTOR
// Simulates tool execution for testing
// ============================================================================

function createMockToolExecutor() {
  return {
    async execute(
      toolName: string,
      parameters: Record<string, unknown>,
      timeoutMs: number,
      signal?: AbortSignal
    ) {
      const startTime = Date.now();
      
      // Simulate tool execution
      await new Promise(resolve => setTimeout(resolve, Math.min(100, timeoutMs / 10)));
      
      // Check for abort
      if (signal?.aborted) {
        return {
          success: false,
          error: "Tool call aborted",
          latency_ms: Date.now() - startTime,
        };
      }
      
      // Mock responses based on tool
      const mockResponses: Record<string, any> = {
        search_tables: {
          available: true,
          table_id: "table_123",
          capacity: parameters.party_size as number,
        },
        reserve_table: {
          reservation_id: `res_${randomUUID().slice(0, 8)}`,
          confirmed: true,
          table_id: "table_123",
        },
        send_confirmation: {
          message_id: `msg_${randomUUID().slice(0, 8)}`,
          sent: true,
        },
      };
      
      const output = mockResponses[toolName] || { success: true };
      
      return {
        success: true,
        output,
        latency_ms: Date.now() - startTime,
      };
    },
  };
}

// ============================================================================
// GOLDEN PATH TEST
// Canonical flow: User wants to book a restaurant table
// ============================================================================

describe("Golden Path - Restaurant Booking", () => {
  beforeEach(async () => {
    // Clean up Redis before each test
    const keys = await redis.keys("execution:*");
    if (keys.length > 0) {
      await redis.del(keys);
    }
  });

  it("should complete full booking flow successfully", async () => {
    // =========================================================================
    // STEP 1: Parse User Intent
    // =========================================================================

    const userInput = "Book a table for 4 people at The Italian Place tonight at 7pm";

    const parseResult = await parseIntent(userInput, {
      lat: 40.7128,
      lng: -74.0060,
    });

    const intent = parseResult.intent;
    
    expect(intent).toBeDefined();
    expect(intent.id).toBeDefined();
    expect(intent.type).toBe("ACTION");
    expect(intent.parameters).toMatchObject({
      restaurant_name: expect.any(String),
      party_size: 4,
      time: expect.any(String),
    });

    console.log(`[GoldenPath] ✓ Intent parsed: ${intent.type}`);
    
    // =========================================================================
    // STEP 2: Generate Plan
    // =========================================================================
    
    const planResult = await generatePlan(intent, {
      available_tools: [
        {
          name: "search_tables",
          description: "Search for available tables",
          parameters: {
            restaurant_name: { type: "string", required: true },
            party_size: { type: "number", required: true },
            time: { type: "string", required: true },
          },
        },
        {
          name: "reserve_table",
          description: "Reserve a table",
          parameters: {
            restaurant_name: { type: "string", required: true },
            party_size: { type: "number", required: true },
            time: { type: "string", required: true },
            table_id: { type: "string", required: true },
          },
        },
        {
          name: "send_confirmation",
          description: "Send confirmation to user",
          parameters: {
            reservation_id: { type: "string", required: true },
            user_email: { type: "string", required: false },
          },
        },
      ],
    });
    
    expect(planResult.plan).toBeDefined();
    expect(planResult.plan.steps.length).toBeGreaterThan(0);
    expect(planResult.plan.steps.length).toBeLessThanOrEqual(10); // Constraint check
    
    console.log(`[GoldenPath] ✓ Plan generated: ${planResult.plan.steps.length} steps`);
    
    // =========================================================================
    // STEP 3: Verify Plan (Deterministic Safety Check)
    // =========================================================================
    
    const verification = verifyPlan(planResult.plan, DEFAULT_SAFETY_POLICY);
    
    expect(verification.valid).toBe(true);
    expect(verification.reason).toBeUndefined();
    
    console.log(`[GoldenPath] ✓ Plan verified: ${verification.valid}`);
    
    // =========================================================================
    // STEP 4: Execute Plan via WorkflowMachine
    // =========================================================================
    
    const executionId = `exec_golden_${randomUUID().slice(0, 8)}`;
    const toolExecutor = createMockToolExecutor();
    
    const machine = new WorkflowMachine(executionId, toolExecutor);
    machine.setPlan(planResult.plan);
    
    const result = await machine.execute();
    
    // =========================================================================
    // STEP 5: Verify Execution Result
    // =========================================================================
    
    expect(result.success).toBe(true);
    expect(result.completedSteps).toBe(planResult.plan.steps.length);
    expect(result.failedSteps).toBe(0);
    expect(result.state.status).toBe("COMPLETED");
    
    console.log(`[GoldenPath] ✓ Execution completed: ${result.completedSteps}/${result.totalSteps} steps`);
    
    // =========================================================================
    // STEP 6: Verify State Persistence
    // =========================================================================
    
    const persistedState = await loadExecutionState(executionId);
    
    expect(persistedState).toBeDefined();
    expect(persistedState?.status).toBe("COMPLETED");
    expect(persistedState?.step_states.filter(s => s.status === "completed").length).toBe(
      planResult.plan.steps.length
    );
    
    console.log(`[GoldenPath] ✓ State persisted to Redis`);
    
    // =========================================================================
    // STEP 7: Verify Trace
    // =========================================================================
    
    expect(result.state.trace).toBeDefined();
    expect(result.state.trace?.length).toBeGreaterThan(0);
    
    // Check for key trace events
    const traceEvents = result.state.trace?.map(t => t.event) || [];
    expect(traceEvents).toContain("plan_generated");
    expect(traceEvents).toContain("step_executed");
    
    console.log(`[GoldenPath] ✓ Trace complete: ${traceEvents.length} events`);
    
    // =========================================================================
    // GOLDEN PATH COMPLETE
    // All steps verified successfully
    // =========================================================================
    
    console.log("[GoldenPath] ================================================");
    console.log("[GoldenPath] GOLDEN PATH COMPLETE: All checks passed ✓");
    console.log("[GoldenPath] ================================================");
  });
});
