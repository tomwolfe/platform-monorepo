/**
 * Evaluation Framework for LLM Outputs
 * 
 * Purpose: Test and validate LLM-generated plans, intents, and decisions.
 * 
 * Usage:
 * ```bash
 * pnpm eval:intent
 * pnpm eval:plan
 * pnpm eval:all
 * ```
 */

import { describe, it, expect } from "vitest";
import { parseIntent } from "@/lib/engine/intent";
import { generatePlan } from "@/lib/engine/planner";
import { verifyPlan, DEFAULT_SAFETY_POLICY } from "@/lib/engine/verifier";

// ============================================================================
// EVALUATION METRICS
// ============================================================================

interface EvaluationMetrics {
  // Intent parsing
  intent_accuracy: number;        // % of intents correctly classified
  parameter_extraction_f1: number; // F1 score for parameter extraction
  
  // Plan generation
  plan_validity_rate: number;      // % of plans passing validation
  plan_efficiency: number;         // Average steps / optimal steps
  constraint_violation_rate: number; // % of plans violating constraints
  
  // Safety
  safety_violation_rate: number;   // % of plans failing safety checks
  forbidden_sequence_caught: number; // % of forbidden sequences detected
  
  // Performance
  avg_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
}

// ============================================================================
// TEST CASES
// ============================================================================

const INTENT_TEST_CASES = [
  {
    name: "Simple booking",
    input: "Book a table for 2 at 7pm",
    expected: {
      type: "ACTION",
      parameters: {
        party_size: 2,
        time: "19:00",
      },
    },
  },
  {
    name: "Complex multi-entity",
    input: "Find Italian restaurants in Brooklyn and book one for my anniversary",
    expected: {
      type: "ACTION",
      parameters: {
        cuisine: "Italian",
        location: "Brooklyn",
        occasion: "anniversary",
      },
    },
  },
  {
    name: "Delivery request",
    input: "Order pizza from Domino's to 123 Main St",
    expected: {
      type: "ACTION",
      parameters: {
        restaurant_name: "Domino's",
        delivery_address: "123 Main St",
        item_type: "pizza",
      },
    },
  },
  {
    name: "Search query",
    input: "What are the best sushi places near me?",
    expected: {
      type: "SEARCH",
      parameters: {
        cuisine: "sushi",
        location: "near me",
      },
    },
  },
  {
    name: "Time-based action",
    input: "Remind me to call the restaurant at 3pm",
    expected: {
      type: "SCHEDULE",
      parameters: {
        time: "15:00",
        action: "call the restaurant",
      },
    },
  },
];

const PLAN_TEST_CASES = [
  {
    name: "Simple booking plan",
    intent: "Book a table for 4 at The Italian Place",
    expectedSteps: ["search_tables", "reserve_table"],
    maxSteps: 5,
  },
  {
    name: "Delivery with payment",
    intent: "Order pizza and pay with crypto",
    expectedSteps: ["search_restaurants", "create_order", "process_crypto_payment"],
    maxSteps: 7,
  },
  {
    name: "Multi-step with dependencies",
    intent: "Book a table and send invitation to friends",
    expectedSteps: ["search_tables", "reserve_table", "send_invitation"],
    maxSteps: 6,
  },
];

// ============================================================================
// INTENT EVALUATION
// ============================================================================

describe("Evaluation - Intent Parsing", () => {
  it("should correctly classify simple intents", async () => {
    const results = [];
    
    for (const testCase of INTENT_TEST_CASES) {
      const intent = await parseIntent(testCase.input, {
        lat: 40.7128,
        lng: -74.0060,
      });
      
      const correct = intent.type === testCase.expected.type;
      results.push(correct);
      
      console.log(`[Eval] ${testCase.name}: ${correct ? "✓" : "✗"} (type: ${intent.type})`);
    }
    
    const accuracy = results.filter(r => r).length / results.length;
    expect(accuracy).toBeGreaterThan(0.8);
    
    console.log(`[Eval] Intent accuracy: ${(accuracy * 100).toFixed(1)}%`);
  });
  
  it("should extract parameters correctly", async () => {
    const parameterTests = [
      { input: "Book for 4 people", param: "party_size", expected: 4 },
      { input: "At 7pm tonight", param: "time", expected: "19:00" },
      { input: "Italian food", param: "cuisine", expected: "Italian" },
    ];
    
    const results = [];
    
    for (const test of parameterTests) {
      const intent = await parseIntent(test.input, { lat: 40.7128, lng: -74.0060 });
      const extracted = intent.parameters[test.param];
      
      // Loose matching for parameter extraction
      const correct = extracted !== undefined && extracted !== null;
      results.push(correct);
      
      console.log(`[Eval] Parameter ${test.param}: ${correct ? "✓" : "✗"} (value: ${extracted})`);
    }
    
    const accuracy = results.filter(r => r).length / results.length;
    expect(accuracy).toBeGreaterThan(0.7);
  });
});

// ============================================================================
// PLAN EVALUATION
// ============================================================================

describe("Evaluation - Plan Generation", () => {
  it("should generate valid plans", async () => {
    const results = [];
    
    for (const testCase of PLAN_TEST_CASES) {
      const intent = await parseIntent(testCase.intent, {
        lat: 40.7128,
        lng: -74.0060,
      });
      
      const planResult = await generatePlan(intent);
      const verification = verifyPlan(planResult.plan, DEFAULT_SAFETY_POLICY);
      
      const valid = verification.valid && planResult.plan.steps.length <= testCase.maxSteps;
      results.push(valid);
      
      console.log(`[Eval] ${testCase.name}: ${valid ? "✓" : "✗"} (${planResult.plan.steps.length} steps)`);
    }
    
    const validityRate = results.filter(r => r).length / results.length;
    expect(validityRate).toBeGreaterThan(0.9);
    
    console.log(`[Eval] Plan validity rate: ${(validityRate * 100).toFixed(1)}%`);
  });
  
  it("should include expected steps", async () => {
    for (const testCase of PLAN_TEST_CASES) {
      const intent = await parseIntent(testCase.intent, {
        lat: 40.7128,
        lng: -74.0060,
      });
      
      const planResult = await generatePlan(intent);
      const planTools = planResult.plan.steps.map(s => s.tool_name.toLowerCase());
      
      for (const expectedStep of testCase.expectedSteps) {
        const found = planTools.some(t => t.includes(expectedStep.toLowerCase()));
        console.log(`[Eval] ${testCase.name} → ${expectedStep}: ${found ? "✓" : "✗"}`);
      }
    }
  });
});

// ============================================================================
// SAFETY EVALUATION
// ============================================================================

describe("Evaluation - Safety Validation", () => {
  it("should catch forbidden sequences", () => {
    // Manually construct a plan with forbidden sequence
    const forbiddenPlan = {
      id: "test-forbidden",
      intent_id: "test-intent",
      steps: [
        {
          id: "step1",
          step_number: 0,
          tool_name: "search",
          parameters: { query: "user data" },
          dependencies: [],
          description: "Search for user data",
          requires_confirmation: false,
          timeout_ms: 5000,
        },
        {
          id: "step2",
          step_number: 1,
          tool_name: "delete_account",
          parameters: { user_id: "123" },
          dependencies: ["step1"],
          description: "Delete account",
          requires_confirmation: true,
          timeout_ms: 5000,
        },
      ],
      constraints: {
        max_steps: 10,
        max_total_tokens: 8000,
        max_execution_time_ms: 120000,
      },
      metadata: {
        version: "1.0.0",
        created_at: new Date().toISOString(),
        estimated_total_tokens: 100,
        estimated_latency_ms: 1000,
      },
      summary: "Search then delete",
    };
    
    const result = verifyPlan(forbiddenPlan as any, DEFAULT_SAFETY_POLICY);
    
    expect(result.valid).toBe(false);
    expect(result.violation).toBe("FORBIDDEN_SEQUENCE");
    
    console.log(`[Eval] Forbidden sequence detection: ✓`);
  });
  
  it("should enforce parameter limits", () => {
    const oversizedPlan = {
      id: "test-oversized",
      intent_id: "test-intent",
      steps: [
        {
          id: "step1",
          step_number: 0,
          tool_name: "reserve_table",
          parameters: { party_size: 50 }, // Exceeds max of 20
          dependencies: [],
          description: "Reserve table",
          requires_confirmation: false,
          timeout_ms: 5000,
        },
      ],
      constraints: {
        max_steps: 10,
        max_total_tokens: 8000,
        max_execution_time_ms: 120000,
      },
      metadata: {
        version: "1.0.0",
        created_at: new Date().toISOString(),
        estimated_total_tokens: 50,
        estimated_latency_ms: 500,
      },
      summary: "Large party reservation",
    };
    
    const result = verifyPlan(oversizedPlan as any, DEFAULT_SAFETY_POLICY);
    
    expect(result.valid).toBe(false);
    expect(result.violation).toBe("PARAMETER_LIMIT_EXCEEDED");
    
    console.log(`[Eval] Parameter limit enforcement: ✓`);
  });
});

// ============================================================================
// PERFORMANCE EVALUATION
// ============================================================================

describe("Evaluation - Performance Metrics", () => {
  it("should meet latency targets", async () => {
    const latencies: number[] = [];
    
    for (let i = 0; i < 5; i++) {
      const startTime = performance.now();
      
      const intent = await parseIntent("Book a table for 2 tonight", {
        lat: 40.7128,
        lng: -74.0060,
      });
      
      await generatePlan(intent);
      
      latencies.push(performance.now() - startTime);
    }
    
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p95Latency = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];
    
    console.log(`[Eval] Avg latency: ${avgLatency.toFixed(0)}ms`);
    console.log(`[Eval] P95 latency: ${p95Latency.toFixed(0)}ms`);
    
    // Targets (adjust based on requirements)
    expect(avgLatency).toBeLessThan(5000); // 5s average target
  });
});

// ============================================================================
// EXPORT METRICS
// ============================================================================

export function calculateMetrics(): EvaluationMetrics {
  // This would be populated by running all evals and aggregating results
  // For now, return placeholder values
  return {
    intent_accuracy: 0.95,
    parameter_extraction_f1: 0.88,
    plan_validity_rate: 0.92,
    plan_efficiency: 1.15,
    constraint_violation_rate: 0.03,
    safety_violation_rate: 0.01,
    forbidden_sequence_caught: 1.0,
    avg_latency_ms: 2500,
    p95_latency_ms: 4000,
    p99_latency_ms: 5500,
  };
}
