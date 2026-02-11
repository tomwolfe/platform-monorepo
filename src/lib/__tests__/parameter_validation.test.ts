
import { normalizeIntent } from "../normalization";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const testResults: TestResult[] = [];

function assert(name: string, condition: boolean, errorMessage?: string): void {
  if (condition) {
    testResults.push({ name, passed: true });
    console.log(`✓ PASS: ${name}`);
  } else {
    testResults.push({ name, passed: false, error: errorMessage });
    console.error(`✗ FAIL: ${name}${errorMessage ? ` - ${errorMessage}` : ""}`);
  }
}

function printSummary(): void {
  console.log("\n" + "=".repeat(60));
  console.log("TEST SUMMARY");
  console.log("=".repeat(60));
  
  const passed = testResults.filter(r => r.passed).length;
  const failed = testResults.filter(r => !r.passed).length;
  
  console.log(`Total: ${testResults.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

async function testParameterValidation() {
  console.log("\n--- TEST: Deep Semantic Parameter Validation ---");
  const modelId = "test-model";

  // Test 1: Past dates in SCHEDULE
  const pastDate = new Date();
  pastDate.setFullYear(pastDate.getFullYear() - 1);
  
  const candidatePast = {
    type: "SCHEDULE",
    confidence: 0.95,
    parameters: {
      action: "SCHEDULE",
      temporal_expression: pastDate.toISOString(),
      topic: "Past meeting"
    },
    explanation: "Scheduling a meeting in the past."
  };

  const normalizedPast = normalizeIntent(candidatePast, "Schedule a meeting for last year", modelId);
  
  assert(
    "Should penalize confidence for past dates in SCHEDULE intents",
    normalizedPast.confidence < 0.85,
    `Confidence ${normalizedPast.confidence} is not less than 0.85`
  );

  assert(
    "Should include reason in explanation for past date penalty",
    normalizedPast.explanation?.toLowerCase().includes("past") ?? false,
    "Explanation does not mention 'past'"
  );

  // Test 2: Future dates in SCHEDULE
  const futureDate = new Date();
  futureDate.setFullYear(futureDate.getFullYear() + 1);
  
  const candidateFuture = {
    type: "SCHEDULE",
    confidence: 0.95,
    parameters: {
      action: "SCHEDULE",
      temporal_expression: futureDate.toISOString(),
      topic: "Future meeting"
    },
    explanation: "Scheduling a meeting in the future."
  };

  const normalizedFuture = normalizeIntent(candidateFuture, "Schedule a meeting for next year", modelId);
  
  assert(
    "Should accept future dates in SCHEDULE intents with high confidence",
    normalizedFuture.confidence === 0.95 && normalizedFuture.type === "SCHEDULE",
    `Confidence is ${normalizedFuture.confidence}, type is ${normalizedFuture.type}`
  );

  console.log("Parameter validation tests completed");
}

async function runTests() {
  try {
    await testParameterValidation();
    printSummary();
  } catch (error) {
    console.error("Test runner crashed:", error);
    process.exit(1);
  }
}

runTests();
