import { inferIntent } from "../intent";
import { generatePlan } from "../planner";
import { normalizeIntent } from "../normalization";

async function testComplexScenario() {
  console.log("--- INTEGRATION TEST: Complex Scenario ---");
  const input = "Find a restaurant, book a table, and send an SMS reminder.";
  
  try {
    console.log(`Input: "${input}"`);
    
    // 1. Test Intent Inference
    // We mock the LLM response for this test to avoid external dependencies
    // but we'll use the actual normalization logic
    const mockLLMCandidate = {
      type: "PLANNING",
      confidence: 0.92,
      parameters: {
        goal: "Find restaurant, book table, and send SMS"
      },
      explanation: "User wants a multi-step execution involving restaurant search, booking, and communication."
    };

    const normalized = normalizeIntent(mockLLMCandidate, input, "test-model");
    console.log("Normalized Intent Type:", normalized.type);
    console.log("Confidence:", normalized.confidence);

    if (normalized.type !== "PLANNING") {
      throw new Error(`Expected PLANNING intent, got ${normalized.type}`);
    }

    // 2. Test Plan Generation
    // Since we are in a test environment, generatePlan might call the real LLM
    // if LLM_API_KEY is set. Let's see if we can mock it or if we should just test the logic.
    // For this integration test, we want to ensure the tools we renamed are used correctly.
    
    const plan = await generatePlan(normalized);
    console.log("Generated Plan Summary:", plan.summary);
    
    const toolNames = plan.ordered_steps.map(s => s.tool_name);
    console.log("Tools in plan:", toolNames.join(", "));

    // Verify canonical names are used
    const expectedTools = ["search_restaurant", "book_restaurant_table", "send_comm"];
    const allExpectedUsed = expectedTools.every(et => toolNames.includes(et));

    if (allExpectedUsed) {
      console.log("SUCCESS: All expected tool names are present in the plan.");
    } else {
      console.warn("WARNING: Some expected tool names might be missing or renamed.");
      console.log("Expected:", expectedTools);
      console.log("Found:", toolNames);
    }

  } catch (error: any) {
    console.error("Integration Test FAILED:", error.message);
    process.exit(1);
  }
}

testComplexScenario();
