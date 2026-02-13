import { verifyPlan, SafetyPolicy, DEFAULT_SAFETY_POLICY } from "../engine/verifier";
import { generateIntentHash } from "../engine/intent";
import { Plan } from "../engine/types";
import { randomUUID } from "crypto";

async function runTests() {
  console.log("--- STARTING VERIFICATION TESTS ---");

  const mockPlan: Plan = {
    id: randomUUID(),
    intent_id: randomUUID(),
    steps: [
      {
        id: "step-1",
        step_number: 0,
        tool_name: "reserve_table",
        parameters: { party_size: 10 },
        dependencies: [],
        description: "Book a table",
        timeout_ms: 30000,
      },
    ],
    constraints: {
      max_steps: 10,
      max_total_tokens: 1000,
      max_execution_time_ms: 60000,
    },
    metadata: {
      version: "1.0.0",
      created_at: new Date().toISOString(),
      planning_model_id: "test-model",
      estimated_total_tokens: 100,
      estimated_latency_ms: 1000,
    },
    summary: "Mock plan",
  };

  const policy: SafetyPolicy = {
    forbiddenSequences: [
      ["search", "delete_account"],
    ],
    parameterLimits: [
      {
        tool: "reserve_table",
        parameter: "party_size",
        max: 20,
      },
    ],
  };

  // Test 1: Valid Plan
  const result1 = verifyPlan(mockPlan, policy);
  console.log(`Test 1 (Valid Plan): ${result1.valid ? "PASSED" : "FAILED"}`);

  // Test 2: Parameter Limit Exceeded
  const invalidPlan: Plan = {
    ...mockPlan,
    steps: [
      {
        ...mockPlan.steps[0],
        parameters: { party_size: 100 },
      },
    ],
  };
  const result2 = verifyPlan(invalidPlan, policy);
  console.log(`Test 2 (Limit Exceeded): ${!result2.valid && result2.violation === "PARAMETER_LIMIT_EXCEEDED" ? "PASSED" : "FAILED"}`);
  if (!result2.valid) console.log(`  Reason: ${result2.reason}`);

  // Test 3: Forbidden Sequence
  const sequencePlan: Plan = {
    ...mockPlan,
    steps: [
      {
        id: "step-1",
        step_number: 0,
        tool_name: "search",
        parameters: { query: "user" },
        dependencies: [],
        description: "Search for user",
        timeout_ms: 30000,
      },
      {
        id: "step-2",
        step_number: 1,
        tool_name: "delete_account",
        parameters: { id: "123" },
        dependencies: ["step-1"],
        description: "Delete user",
        timeout_ms: 30000,
      },
    ],
  };
  const result3 = verifyPlan(sequencePlan, policy);
  console.log(`Test 3 (Forbidden Sequence): ${!result3.valid && result3.violation === "FORBIDDEN_SEQUENCE" ? "PASSED" : "FAILED"}`);
  if (!result3.valid) console.log(`  Reason: ${result3.reason}`);

  // Test 4: Safe Sequence
  const safeSequencePlan: Plan = {
    ...mockPlan,
    steps: [
      {
        id: "step-1",
        step_number: 0,
        tool_name: "search",
        parameters: { query: "restaurant" },
        dependencies: [],
        description: "Search for restaurant",
        timeout_ms: 30000,
      },
      {
        id: "step-2",
        step_number: 1,
        tool_name: "reserve_table",
        parameters: { party_size: 4 },
        dependencies: ["step-1"],
        description: "Book table",
        timeout_ms: 30000,
      },
    ],
  };
  const result4 = verifyPlan(safeSequencePlan, policy);
  console.log(`Test 4 (Safe Sequence): ${result4.valid ? "PASSED" : "FAILED"}`);

  // Test 5: Intent Hashing
  const hash1 = generateIntentHash("SCHEDULE", { time: "2pm", date: "today" });
  const hash2 = generateIntentHash("SCHEDULE", { date: "today", time: "2pm" });
  console.log(`Test 5 (Deterministic Hash): ${hash1 === hash2 ? "PASSED" : "FAILED"}`);
  
  const hash3 = generateIntentHash("SCHEDULE", { time: "3pm" });
  console.log(`Test 6 (Different Hashes): ${hash1 !== hash3 ? "PASSED" : "FAILED"}`);

  console.log("--- TESTS COMPLETED ---");
}

runTests().catch(console.error);
