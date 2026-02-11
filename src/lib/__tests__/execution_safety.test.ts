import { normalizeIntent } from "../normalization";
import { createExecutionPlan } from "../execution_plan";

async function runExecutionSafetyTest() {
  console.log("--- PHASE 4: EXECUTION SAFETY TEST ---");

  const modelId = "sim-v1";

  // Case 1: Low Risk
  const raw1 = "add meeting tomorrow";
  const cand1 = { type: "ACTION", confidence: 0.9, parameters: { capability: "calendar.create", arguments: { title: "Meeting" } } };
  const intent1 = normalizeIntent(cand1, raw1, modelId);
  const plan1 = createExecutionPlan(intent1);
  console.log(`Low Risk (calendar.create) - Requires Confirmation: ${plan1.requires_total_confirmation}`);
  if (plan1.requires_total_confirmation !== false) {
    console.error("FAIL: Low risk action should not require confirmation");
    process.exit(1);
  }

  // Case 2: High Risk
  const raw2 = "delete all my meetings";
  const cand2 = { type: "ACTION", confidence: 0.9, parameters: { capability: "calendar.delete", arguments: { all: true } } };
  const intent2 = normalizeIntent(cand2, raw2, modelId);
  const plan2 = createExecutionPlan(intent2);
  console.log(`High Risk (calendar.delete) - Requires Confirmation: ${plan2.requires_total_confirmation}`);
  if (plan2.requires_total_confirmation !== true) {
    console.error("FAIL: High risk action MUST require confirmation");
    process.exit(1);
  }

  // Case 3: Unknown Capability
  const raw3 = "hack the planet";
  const cand3 = { type: "ACTION", confidence: 0.9, parameters: { capability: "system.hack", arguments: {} } };
  const intent3 = normalizeIntent(cand3, raw3, modelId);
  try {
    createExecutionPlan(intent3);
    console.error("FAIL: Unknown capability should have been blocked");
    process.exit(1);
  } catch (e: any) {
    console.log(`Unknown Capability blocked: ${e.message}`);
  }

  console.log("PASS: Execution safety guardrails proven.");
}

runExecutionSafetyTest();
