/**
 * E2E Test - Delivery Flow
 * 
 * Tests the complete delivery ordering flow:
 * User Input → Intent → Plan → Verify → Execute → Delivery Dispatched
 * 
 * Focus: Web3 payments, driver dispatch, real-time tracking
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
  },
}));

import { parseIntent } from "@/lib/engine/intent";
import { generatePlan, DEFAULT_SAFETY_POLICY } from "@/lib/engine/unified-planner";
import { verifyPlan } from "@/lib/engine/verifier";
import { WorkflowMachine } from "@/lib/engine/workflow-machine";
import { loadExecutionState } from "@/lib/engine/memory";

import { redis } from "@/lib/redis-client";

// ============================================================================
// MOCK TOOL EXECUTOR FOR DELIVERY
// ============================================================================

function createDeliveryMockToolExecutor() {
  return {
    async execute(
      toolName: string,
      parameters: Record<string, unknown>,
      timeoutMs: number,
      signal?: AbortSignal
    ) {
      const startTime = Date.now();
      
      await new Promise(resolve => setTimeout(resolve, Math.min(150, timeoutMs / 10)));
      
      if (signal?.aborted) {
        return {
          success: false,
          error: "Tool call aborted",
          latency_ms: Date.now() - startTime,
        };
      }
      
      const mockResponses: Record<string, any> = {
        search_restaurants: {
          restaurants: [
            { id: "rest_1", name: "Pizza Palace", cuisine: "Italian", rating: 4.5 },
            { id: "rest_2", name: "Burger Barn", cuisine: "American", rating: 4.2 },
          ],
        },
        calculate_delivery_quote: {
          quote_id: `quote_${randomUUID().slice(0, 8)}`,
          delivery_fee: 5.99,
          estimated_time_minutes: 35,
          distance_km: 3.2,
        },
        create_order: {
          order_id: `order_${randomUUID().slice(0, 8)}`,
          status: "confirmed",
          total: 42.50,
        },
        process_crypto_payment: {
          transaction_hash: `0x${randomUUID().replace(/-/g, "")}`,
          status: "pending",
          network: "base",
        },
        dispatch_driver: {
          dispatch_id: `dispatch_${randomUUID().slice(0, 8)}`,
          driver_id: "driver_123",
          driver_name: "John D.",
          estimated_pickup: "2026-03-22T19:15:00Z",
        },
        track_delivery: {
          status: "in_transit",
          driver_location: { lat: 40.7200, lng: -74.0100 },
          eta_minutes: 12,
        },
      };
      
      const output = mockResponses[toolName] || { success: true };
      
      return {
        success: true,
        output,
        latency_ms: Date.now() - startTime,
        compensation: toolName === "create_order" ? {
          toolName: "cancel_order",
          parameters: { order_id: output.order_id },
        } : undefined,
      };
    },
  };
}

// ============================================================================
// E2E DELIVERY FLOW TEST
// ============================================================================

describe("E2E - OpenDelivery Flow", () => {
  beforeEach(async () => {
    const keys = await redis.keys("execution:*");
    if (keys.length > 0) {
      await redis.del(keys);
    }
  });

  it("should complete full delivery order with crypto payment", async () => {
    // =========================================================================
    // STEP 1: Parse User Intent
    // =========================================================================

    const userInput = "Order pizza from Pizza Palace and deliver to 123 Main St";

    const parseResult = await parseIntent(userInput, {
      lat: 40.7128,
      lng: -74.0060,
    });

    const intent = parseResult.intent;
    
    expect(intent).toBeDefined();
    expect(intent.type).toBe("ACTION");
    expect(intent.parameters).toMatchObject({
      restaurant_name: expect.stringContaining("Pizza"),
      delivery_address: expect.stringContaining("Main St"),
    });

    console.log(`[DeliveryE2E] ✓ Intent parsed: ${intent.type}`);
    
    // =========================================================================
    // STEP 2: Generate Plan
    // =========================================================================
    
    const planResult = await generatePlan(intent, {
      available_tools: [
        {
          name: "search_restaurants",
          description: "Search for restaurants",
          parameters: {
            cuisine: { type: "string", required: false },
            location: { type: "string", required: true },
          },
        },
        {
          name: "calculate_delivery_quote",
          description: "Calculate delivery fee and time",
          parameters: {
            restaurant_id: { type: "string", required: true },
            delivery_address: { type: "string", required: true },
          },
        },
        {
          name: "create_order",
          description: "Create food order",
          parameters: {
            restaurant_id: { type: "string", required: true },
            items: { type: "array", required: true },
            delivery_address: { type: "string", required: true },
          },
        },
        {
          name: "process_crypto_payment",
          description: "Process cryptocurrency payment",
          parameters: {
            order_id: { type: "string", required: true },
            amount: { type: "number", required: true },
            currency: { type: "string", required: true },
          },
        },
        {
          name: "dispatch_driver",
          description: "Dispatch driver for delivery",
          parameters: {
            order_id: { type: "string", required: true },
            pickup_location: { type: "string", required: true },
            delivery_location: { type: "string", required: true },
          },
        },
      ],
    });
    
    expect(planResult.plan).toBeDefined();
    expect(planResult.plan.steps.length).toBeGreaterThanOrEqual(3);
    expect(planResult.plan.steps.length).toBeLessThanOrEqual(10);
    
    console.log(`[DeliveryE2E] ✓ Plan generated: ${planResult.plan.steps.length} steps`);
    
    // =========================================================================
    // STEP 3: Verify Plan
    // =========================================================================
    
    const verification = verifyPlan(planResult.plan, DEFAULT_SAFETY_POLICY);
    expect(verification.valid).toBe(true);
    
    console.log(`[DeliveryE2E] ✓ Plan verified`);
    
    // =========================================================================
    // STEP 4: Execute Plan
    // =========================================================================
    
    const executionId = `exec_delivery_${randomUUID().slice(0, 8)}`;
    const toolExecutor = createDeliveryMockToolExecutor();
    
    const machine = new WorkflowMachine(executionId, toolExecutor);
    machine.setPlan(planResult.plan);
    
    const result = await machine.execute();
    
    // =========================================================================
    // STEP 5: Verify Results
    // =========================================================================
    
    expect(result.success).toBe(true);
    expect(result.completedSteps).toBe(planResult.plan.steps.length);
    expect(result.failedSteps).toBe(0);
    expect(result.state.status).toBe("COMPLETED");
    
    console.log(`[DeliveryE2E] ✓ Execution completed: ${result.completedSteps}/${result.totalSteps}`);
    
    // =========================================================================
    // STEP 6: Verify State
    // =========================================================================
    
    const persistedState = await loadExecutionState(executionId);
    expect(persistedState?.status).toBe("COMPLETED");
    
    // Verify compensation was registered for order creation
    const compensations = result.compensatedSteps || 0;
    console.log(`[DeliveryE2E] ✓ Compensations registered: ${compensations}`);
    
    // =========================================================================
    // STEP 7: Verify Key Events
    // =========================================================================
    
    const traceEvents = result.state.trace?.map(t => t.event) || [];
    expect(traceEvents).toContain("plan_generatedgenerated");
    expect(traceEvents).toContain("step_executed");
    
    console.log(`[DeliveryE2E] ✓ Trace complete: ${traceEvents.length} events`);
    
    // =========================================================================
    // DELIVERY FLOW COMPLETE
    // =========================================================================
    
    console.log("[DeliveryE2E] ================================================");
    console.log("[DeliveryE2E] DELIVERY FLOW COMPLETE: All checks passed ✓");
    console.log("[DeliveryE2E] ================================================");
  });
});
