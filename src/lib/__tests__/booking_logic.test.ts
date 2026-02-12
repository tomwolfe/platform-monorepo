
import { reserve_table } from "../tools/booking";

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
  console.log("TEST SUMMARY: Booking Logic");
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

async function testBookingLogic() {
  console.log("\n--- TEST: Restaurant Booking Logic ---");

  const validParams = {
    restaurant_name: "Test Italian",
    restaurant_address: "123 Pasta St",
    date: "2026-02-11",
    time: "19:00",
    party_size: 2,
    contact_name: "John Doe",
    contact_phone: "555-1234",
    contact_email: "john@example.com"
  };

  // Test 1: Confirmation Gate
  console.log("Testing confirmation gate...");
  const result1 = await reserve_table({ ...validParams, is_confirmed: false });
  assert(
    "Should return success: false when is_confirmed is false",
    result1.success === false,
    "Expected success to be false"
  );
  assert(
    "Should return CONFIRMATION_REQUIRED error message",
    result1.error?.includes("CONFIRMATION_REQUIRED") ?? false,
    `Error message was: ${result1.error}`
  );

  // Test 2: Successful booking when confirmed
  console.log("Testing successful booking...");
  const result2 = await reserve_table({ ...validParams, is_confirmed: true });
  assert(
    "Should return success: true when all parameters are valid and confirmed",
    result2.success === true,
    `Error was: ${result2.error}`
  );
  assert(
    "Should use 'time' parameter instead of 'reservation_time'",
    result2.result.time === "19:00",
    `Expected time to be 19:00, got ${result2.result.time}`
  );
  assert(
    "Should return a confirmation code",
    !!result2.result.confirmation_code,
    "Missing confirmation code"
  );

  // Test 3: Parameter Validation (Missing required field)
  console.log("Testing parameter validation (missing field)...");
  // @ts-ignore - testing runtime validation
  const result3 = await reserve_table({ 
    restaurant_name: "Test",
    date: "2026-02-11",
    time: "19:00",
    is_confirmed: true 
    // party_size, contact_name, contact_phone are missing
  });
  assert(
    "Should fail validation when required fields are missing",
    result3.success === false,
    "Should have failed due to missing fields"
  );
  assert(
    "Should mention invalid parameters in error",
    result3.error?.includes("Invalid parameters") ?? false,
    `Error message was: ${result3.error}`
  );

  console.log("Booking logic tests completed");
}

async function runTests() {
  try {
    await testBookingLogic();
    printSummary();
  } catch (error) {
    console.error("Test runner crashed:", error);
    process.exit(1);
  }
}

runTests();
