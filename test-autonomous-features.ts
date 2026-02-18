/**
 * Autonomous Agent Features - Test Script
 * 
 * Run: pnpm tsx test-autonomous-features.ts
 * 
 * Tests:
 * 1. Failover Policy Engine
 * 2. Pre-Flight State Injection (Hard Constraints)
 * 3. Semantic Vector Store
 * 4. Schema Evolution Service
 */

import { 
  FailoverPolicyEngine, 
  FailoverPolicyBuilder,
  createSemanticVectorStore,
  createSchemaEvolutionService,
} from "./packages/shared/src/index";

// ============================================================================
// TEST 1: FAILOVER POLICY ENGINE
// ============================================================================

console.log("\n" + "=".repeat(80));
console.log("TEST 1: FAILOVER POLICY ENGINE");
console.log("=".repeat(80) + "\n");

async function testFailoverPolicyEngine() {
  const engine = new FailoverPolicyEngine();

  // Test Case 1: Restaurant Full Scenario
  console.log("📍 Test Case 1: Restaurant Full → Suggest Alternatives");
  console.log("-".repeat(60));
  
  const result1 = engine.evaluate({
    intent_type: "BOOKING",
    failure_reason: "RESTAURANT_FULL",
    confidence: 0.85,
    party_size: 2,
    requested_time: "19:00",
  });

  console.log(`✅ Matched: ${result1.matched}`);
  if (result1.matched && result1.policy) {
    console.log(`   Policy: ${result1.policy.name}`);
    console.log(`   Confidence: ${(result1.confidence * 100).toFixed(0)}%`);
    console.log(`   Recommended Action: ${result1.recommended_action?.type}`);
    console.log(`   Message: ${result1.recommended_action?.message_template}`);
  }

  // Get specific suggestions
  const suggestions = engine.getAlternativeSuggestions({
    intent_type: "BOOKING",
    failure_reason: "RESTAURANT_FULL",
    confidence: 0.85,
    party_size: 2,
    requested_time: "19:00",
  }, result1);

  console.log(`\n   Generated ${suggestions.length} alternative(s):`);
  for (const suggestion of suggestions) {
    console.log(`   - [${suggestion.type}] ${suggestion.message || JSON.stringify(suggestion.value)} (${(suggestion.confidence * 100).toFixed(0)}%)`);
  }

  // Test Case 2: Payment Failed → Retry with Backoff
  console.log("\n\n📍 Test Case 2: Payment Failed → Retry with Backoff");
  console.log("-".repeat(60));
  
  const result2 = engine.evaluate({
    intent_type: "PAYMENT",
    failure_reason: "PAYMENT_FAILED",
    confidence: 0.9,
    attempt_count: 1,
  });

  console.log(`✅ Matched: ${result2.matched}`);
  if (result2.matched && result2.policy) {
    console.log(`   Policy: ${result2.policy.name}`);
    console.log(`   Recommended Action: ${result2.recommended_action?.type}`);
    console.log(`   Max Retries: ${result2.recommended_action?.max_retries}`);
    console.log(`   Retry Delay: ${result2.recommended_action?.retry_delay_ms}ms`);
  }

  // Test Case 3: Party Size Too Large
  console.log("\n\n📍 Test Case 3: Party Size Too Large → Suggest Split");
  console.log("-".repeat(60));
  
  const result3 = engine.evaluate({
    intent_type: "BOOKING",
    failure_reason: "PARTY_SIZE_TOO_LARGE",
    confidence: 0.8,
    party_size: 12,
  });

  console.log(`✅ Matched: ${result3.matched}`);
  if (result3.matched && result3.policy) {
    console.log(`   Policy: ${result3.policy.name}`);
    console.log(`   Recommended Action: ${result3.recommended_action?.type}`);
    
    const splitSuggestions = engine.getAlternativeSuggestions({
      intent_type: "BOOKING",
      failure_reason: "PARTY_SIZE_TOO_LARGE",
      confidence: 0.8,
      party_size: 12,
    }, result3);

    console.log(`\n   Generated ${splitSuggestions.length} suggestion(s):`);
    for (const suggestion of splitSuggestions) {
      console.log(`   - [${suggestion.type}] ${JSON.stringify(suggestion.value)}`);
    }
  }

  // Test Case 4: Custom Policy Builder
  console.log("\n\n📍 Test Case 4: Custom Policy Builder");
  console.log("-".repeat(60));
  
  const customPolicy = new FailoverPolicyBuilder("VIP Guest Recovery")
    .forIntent("BOOKING")
    .onFailure("RESTAURANT_FULL")
    .withMinConfidence(0.7)
    .forPartySize(1, 4)
    .thenSuggestAlternativeTime([-15, 15, -30, 30], "VIP guest: How about {time}?")
    .thenTriggerDelivery({ min_order_amount: 2000 }, "VIP delivery available")
    .thenEscalateToHuman("VIP guest - call concierge at {phone}")
    .build();

  // Use factory function with custom policies
  const customEngine = new FailoverPolicyEngine([customPolicy]);
  
  const result4 = customEngine.evaluate({
    intent_type: "BOOKING",
    failure_reason: "RESTAURANT_FULL",
    confidence: 0.9,
    party_size: 2,
  });

  console.log(`✅ Custom Policy Created: ${customPolicy.name}`);
  console.log(`   Actions: ${customPolicy.actions.length}`);
  console.log(`   Matched: ${result4.matched}`);
  if (result4.matched) {
    console.log(`   Recommended: ${result4.recommended_action?.type}`);
  }

  console.log("\n✅ Failover Policy Engine tests complete!\n");
}

// ============================================================================
// TEST 2: SEMANTIC VECTOR STORE
// ============================================================================

console.log("\n" + "=".repeat(80));
console.log("TEST 2: SEMANTIC VECTOR STORE");
console.log("=".repeat(80) + "\n");

async function testSemanticVectorStore() {
  const vectorStore = createSemanticVectorStore({
    useMockEmbeddings: true, // Use mock for testing without API key
    ttlSeconds: 3600, // 1 hour for testing
  });

  // Test Case 1: Add Memories
  console.log("📍 Test Case 1: Add Semantic Memories");
  console.log("-".repeat(60));
  
  const testMemories = [
    {
      id: "mem_001",
      userId: "user_test_001",
      intentType: "BOOKING",
      rawText: "Book a table for 2 at Pesto Place tonight at 7pm",
      parameters: {
        restaurantId: "rest_123",
        restaurantSlug: "pestoplace",
        partySize: 2,
        time: "19:00",
      },
      timestamp: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
      executionId: "exec_001",
      outcome: "success" as const,
    },
    {
      id: "mem_002",
      userId: "user_test_001",
      intentType: "BOOKING",
      rawText: "Reserve a table for four people this Friday at 8pm",
      parameters: {
        restaurantId: "rest_456",
        partySize: 4,
        time: "20:00",
      },
      timestamp: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
      executionId: "exec_002",
      outcome: "failed" as const,
    },
    {
      id: "mem_003",
      userId: "user_test_002",
      intentType: "DELIVERY",
      rawText: "Order delivery from Bella Italia to my office",
      parameters: {
        restaurantId: "rest_789",
        deliveryAddress: "123 Market St",
      },
      timestamp: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
      executionId: "exec_003",
      outcome: "success" as const,
    },
  ];

  for (const memory of testMemories) {
    const entry = await vectorStore.addEntry(memory);
    console.log(`✅ Added: ${entry.rawText.substring(0, 50)}...`);
  }

  // Test Case 2: Search by Query
  console.log("\n\n📍 Test Case 2: Search by Semantic Similarity");
  console.log("-".repeat(60));
  
  const searchResults = await vectorStore.search({
    query: "Reserve a table for two people this evening",
    userId: "user_test_001",
    limit: 5,
    minSimilarity: 0.5,
  });

  console.log(`🔍 Found ${searchResults.length} similar memories:`);
  for (const result of searchResults) {
    console.log(`   [${result.rank}] ${(result.similarity * 100).toFixed(1)}% match`);
    console.log(`       Intent: ${result.entry.intentType}`);
    console.log(`       Text: ${result.entry.rawText}`);
    console.log(`       Outcome: ${result.entry.outcome}`);
  }

  // Test Case 3: Search by Restaurant
  console.log("\n\n📍 Test Case 3: Search by Restaurant Context");
  console.log("-".repeat(60));
  
  const restaurantResults = await vectorStore.search({
    query: "booking reservation",
    restaurantId: "rest_123",
    limit: 5,
  });

  console.log(`🔍 Found ${restaurantResults.length} memories for restaurant rest_123`);

  // Test Case 4: Get Recent Memories
  console.log("\n\n📍 Test Case 4: Get Recent Memories");
  console.log("-".repeat(60));
  
  const recentMemories = await vectorStore.getRecentMemories("user_test_001", 10);
  console.log(`📅 Retrieved ${recentMemories.length} recent memories for user_test_001`);
  for (const memory of recentMemories.slice(0, 3)) {
    console.log(`   - ${memory.intentType}: ${memory.rawText.substring(0, 40)}...`);
  }

  // Test Case 5: Get Statistics
  console.log("\n\n📍 Test Case 5: Vector Store Statistics");
  console.log("-".repeat(60));
  
  const stats = await vectorStore.getStats();
  console.log(`📊 Total Entries: ${stats.totalEntries}`);
  console.log(`📊 Unique Users: ${stats.uniqueUsers}`);
  console.log(`📊 Unique Restaurants: ${stats.uniqueRestaurants}`);
  console.log(`📊 Avg Entries per User: ${stats.avgEntriesPerUser.toFixed(1)}`);

  console.log("\n✅ Semantic Vector Store tests complete!\n");
}

// ============================================================================
// TEST 3: SCHEMA EVOLUTION SERVICE
// ============================================================================

console.log("\n" + "=".repeat(80));
console.log("TEST 3: SCHEMA EVOLUTION SERVICE");
console.log("=".repeat(80) + "\n");

async function testSchemaEvolution() {
  const schemaEvolution = createSchemaEvolutionService({
    mismatchThreshold: 3, // Lower threshold for testing
    eventTtlSeconds: 3600, // 1 hour for testing
  });

  // Test Case 1: Record Mismatches
  console.log("📍 Test Case 1: Record Schema Mismatches");
  console.log("-".repeat(60));
  
  // Simulate LLM consistently adding 'date' field when schema only expects 'time'
  for (let i = 1; i <= 5; i++) {
    const event = await schemaEvolution.recordMismatch({
      intentType: "BOOKING",
      toolName: "book_restaurant_table",
      timestamp: new Date().toISOString(),
      llmParameters: {
        restaurantId: "rest_123",
        partySize: 2,
        time: "19:00",
        date: "2024-02-17", // ← LLM keeps adding this!
      },
      expectedFields: ["restaurantId", "partySize", "time"],
      unexpectedFields: ["date"],
      missingFields: [],
      errors: [{
        field: "date",
        message: "Unknown field 'date'. Expected: restaurantId, partySize, time",
        code: "unrecognized_keys",
      }],
      executionId: `exec_test_${i}`,
      userId: "user_test_001",
    });

    console.log(`✅ Recorded mismatch #${i}: ${event.unexpectedFields.join(", ")}`);
  }

  // Test Case 2: Check for Auto-Proposal
  console.log("\n\n📍 Test Case 2: Check for Auto-Generated Proposal");
  console.log("-".repeat(60));
  
  const proposals = await schemaEvolution.getProposals("BOOKING", "book_restaurant_table", "pending");
  console.log(`📋 Found ${proposals.length} pending proposal(s)`);

  for (const proposal of proposals) {
    console.log(`\n   Proposal: ${proposal.id}`);
    console.log(`   Reason: ${proposal.reason}`);
    console.log(`   Proposed Fields: ${proposal.proposedFields.map(f => f.name).join(", ")}`);
    console.log(`   Evidence: ${proposal.evidence.length} mismatch events`);
    console.log(`   First Mismatch: ${new Date(proposal.firstMismatchAt).toLocaleTimeString()}`);
    console.log(`   Last Mismatch: ${new Date(proposal.lastMismatchAt).toLocaleTimeString()}`);

    // Test Case 3: Review Proposal
    console.log("\n\n📍 Test Case 3: Review and Approve Proposal");
    console.log("-".repeat(60));
    
    const reviewed = await schemaEvolution.reviewProposal(
      proposal.id,
      true, // Approve
      "test_admin@example.com",
      "Looks like a valid field to add"
    );

    if (reviewed) {
      console.log(`✅ Proposal ${reviewed.status} by test_admin@example.com`);
      console.log(`   Notes: ${reviewed.reviewNotes}`);
    }

    // Mark as applied
    const applied = await schemaEvolution.markProposalApplied(proposal.id);
    if (applied) {
      console.log(`✅ Proposal marked as applied`);
    }
  }

  // Test Case 4: Get Statistics
  console.log("\n\n📍 Test Case 4: Schema Evolution Statistics");
  console.log("-".repeat(60));
  
  const stats = await schemaEvolution.getStats();
  console.log(`📊 Total Mismatches: ${stats.totalMismatches}`);
  console.log(`📊 Total Proposals: ${stats.totalProposals}`);
  console.log(`📊 Pending: ${stats.pendingProposals}`);
  console.log(`📊 Approved: ${stats.approvedProposals}`);
  console.log(`📊 Rejected: ${stats.rejectedProposals}`);
  console.log(`📊 Applied: ${stats.appliedProposals}`);
  
  console.log(`\n📊 Top Mismatched Fields:`);
  for (const field of stats.topMismatchedFields) {
    console.log(`   - ${field.field}: ${field.count} times (${field.intentTypes.join(", ")})`);
  }

  // Test Case 5: Get Recent Mismatches
  console.log("\n\n📍 Test Case 5: Get Recent Mismatches");
  console.log("-".repeat(60));
  
  const recentMismatches = await schemaEvolution.getRecentMismatches("BOOKING", "book_restaurant_table", 5);
  console.log(`📋 Retrieved ${recentMismatches.length} recent mismatches`);
  for (const mismatch of recentMismatches.slice(0, 3)) {
    console.log(`   - ${new Date(mismatch.timestamp).toLocaleTimeString()}: ${mismatch.unexpectedFields.join(", ")}`);
  }

  console.log("\n✅ Schema Evolution Service tests complete!\n");
}

// ============================================================================
// TEST 4: INTEGRATION - PRE-FLIGHT STATE INJECTION
// ============================================================================

console.log("\n" + "=".repeat(80));
console.log("TEST 4: INTEGRATION - PRE-FLIGHT STATE INJECTION SIMULATION");
console.log("=".repeat(80) + "\n");

async function testPreFlightStateInjection() {
  console.log("📍 Simulating Pre-Flight State Injection Flow");
  console.log("-".repeat(60));
  
  // This simulates what happens in /api/chat/route.ts
  const mockLiveState = {
    restaurantStates: [
      {
        id: "rest_123",
        name: "The Pesto Place",
        tableAvailability: "full" as const,
        hasRecentFailures: true,
      },
      {
        id: "rest_456",
        name: "Bella Italia",
        tableAvailability: "limited" as const,
        waitlistCount: 3,
      },
    ],
    failedBookings: [
      {
        restaurantId: "rest_123",
        restaurantName: "The Pesto Place",
        failureReason: "No tables available for party of 2",
        failedAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
      },
    ],
  };

  // Generate Hard Constraints
  const hardConstraints: string[] = [];
  const fullRestaurants = mockLiveState.restaurantStates.filter(r => r.tableAvailability === "full");
  
  if (fullRestaurants.length > 0) {
    hardConstraints.push(
      `CRITICAL: DO NOT attempt to book at these restaurants (they are full): ${fullRestaurants.map(r => r.name).join(", ")}. ` +
      `Instead, suggest: (1) alternative times, (2) joining waitlist, or (3) delivery options.`
    );
  }

  if (mockLiveState.failedBookings && mockLiveState.failedBookings.length > 0) {
    const failedNames = [...new Set(mockLiveState.failedBookings.map(f => f.restaurantName || f.restaurantId))];
    hardConstraints.push(
      `CRITICAL: These restaurants have recent booking failures - DO NOT attempt booking: ${failedNames.join(", ")}.`
    );
  }

  console.log("🚫 HARD CONSTRAINTS GENERATED:");
  for (const constraint of hardConstraints) {
    console.log(`   - ${constraint.substring(0, 80)}...`);
  }

  // Generate Failover Suggestions
  const engine = new FailoverPolicyEngine();
  const result = engine.evaluate({
    intent_type: "BOOKING",
    failure_reason: "RESTAURANT_FULL",
    confidence: 0.8,
    party_size: 2,
    requested_time: "19:00",
  });

  const suggestions = engine.getAlternativeSuggestions({
    intent_type: "BOOKING",
    failure_reason: "RESTAURANT_FULL",
    confidence: 0.8,
    party_size: 2,
    requested_time: "19:00",
  }, result);

  console.log("\n💡 FAILOVER SUGGESTIONS GENERATED:");
  for (const suggestion of suggestions) {
    console.log(`   - [${suggestion.type}] ${(suggestion.confidence * 100).toFixed(0)}%: ${suggestion.message || JSON.stringify(suggestion.value)}`);
  }

  // Simulate System Prompt Injection
  console.log("\n📝 SIMULATED SYSTEM PROMPT INJECTION:");
  console.log("-".repeat(60));
  console.log("You are an Intention Engine.");
  console.log("");
  console.log("### 🚫 HARD CONSTRAINTS (MUST FOLLOW):");
  hardConstraints.forEach(c => console.log(`- ${c}`));
  console.log("");
  console.log("**WARNING**: Violating these constraints will result in immediate plan rejection.");
  console.log("");
  console.log("### 💡 RECOMMENDED ALTERNATIVES (Pre-computed):");
  suggestions.forEach(s => {
    console.log(`- [${s.type.toUpperCase()}] ${s.message || JSON.stringify(s.value)} (Confidence: ${(s.confidence * 100).toFixed(0)}%)`);
  });
  console.log("");
  console.log("**TIP**: These alternatives have been pre-validated and are ready to offer.");

  console.log("\n✅ Pre-Flight State Injection simulation complete!\n");
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

async function runAllTests() {
  console.log("\n" + "🚀 ".repeat(40));
  console.log("🚀 AUTONOMOUS AGENT FEATURES - TEST SUITE");
  console.log("🚀 ".repeat(40) + "\n");

  try {
    await testFailoverPolicyEngine();
    await testSemanticVectorStore();
    await testSchemaEvolution();
    await testPreFlightStateInjection();

    console.log("\n" + "✅ ".repeat(40));
    console.log("✅ ALL TESTS COMPLETED SUCCESSFULLY!");
    console.log("✅ ".repeat(40) + "\n");

    console.log("📊 Summary:");
    console.log("   ✅ Failover Policy Engine: 4 test cases");
    console.log("   ✅ Semantic Vector Store: 5 test cases");
    console.log("   ✅ Schema Evolution Service: 5 test cases");
    console.log("   ✅ Pre-Flight State Injection: Integration test");
    console.log("\n📖 See AUTONOMOUS_AGENT_EVOLUTION.md for documentation\n");
  } catch (error) {
    console.error("\n❌ TEST FAILED:", error);
    process.exit(1);
  }
}

// Run tests
runAllTests();
