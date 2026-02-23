/**
 * Automated A/B Failover Testing Script
 * 
 * Continuous Resilience Verification
 * Intentionally blocks the TableStack API and verifies that the agent
 * autonomously flips the plan to a Delivery intent without code changes.
 * 
 * This script:
 * 1. Simulates a TableStack API failure (via mock or network blocking)
 * 2. Sends a booking request to the intention engine
 * 3. Verifies the agent autonomously suggests delivery as an alternative
 * 4. Reports the failover success/failure with detailed metrics
 * 
 * Usage:
 *   pnpm tsx scripts/simulate-failover.ts
 *   pnpm tsx scripts/simulate-failover.ts --verbose
 *   pnpm tsx scripts/simulate-failover.ts --restaurant-id "test-restaurant"
 * 
 * @package scripts
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';

// Configuration
const CONFIG = {
  intentionEngineUrl: process.env.INTENTION_ENGINE_URL || 'http://localhost:3001',
  tableStackUrl: process.env.TABLESTACK_URL || 'http://localhost:3002',
  testRestaurantId: process.env.TEST_RESTAURANT_ID || 'test-restaurant',
  testUserId: process.env.TEST_USER_ID || 'test-user-' + randomUUID().substring(0, 8),
  timeout: parseInt(process.env.FAILOVER_TEST_TIMEOUT || '30000', 10),
  verbose: process.argv.includes('--verbose'),
};

// Test scenarios
interface FailoverTestScenario {
  name: string;
  description: string;
  userInput: string;
  expectedFailoverType: 'DELIVERY' | 'WAITLIST' | 'ALTERNATIVE_TIME' | 'ALTERNATIVE_RESTAURANT';
  setup: () => Promise<void>;
  cleanup: () => Promise<void>;
}

// Test results
interface FailoverTestResult {
  scenario: string;
  success: boolean;
  actualFailoverType?: string;
  latencyMs: number;
  llmCorrections: number;
  policyTriggers: string[];
  error?: string;
  trace?: {
    executionId: string;
    traceId: string;
  };
}

// ============================================================================
// MOCK SERVER FOR TABLESTACK API BLOCKING
// ============================================================================

class MockTableStackServer {
  private port: number;
  private server: any;
  private blockRequests: boolean = false;
  private requestCount: number = 0;
  private blockedCount: number = 0;

  constructor(port: number = 49160) {
    this.port = port;
  }

  async start(): Promise<void> {
    const { createServer } = await import('http');
    
    this.server = createServer((req, res) => {
      this.requestCount++;
      
      if (this.blockRequests) {
        this.blockedCount++;
        
        // Simulate different failure modes
        const failureMode = process.env.FAILURE_MODE || 'timeout';
        
        if (failureMode === 'timeout') {
          // Simulate timeout (no response)
          console.log(`[MockTableStack] Blocking request ${req.url} (timeout mode)`);
          return; // Don't respond - causes timeout
        }
        
        if (failureMode === '503') {
          // Simulate service unavailable
          console.log(`[MockTableStack] Blocking request ${req.url} (503 mode)`);
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Service temporarily unavailable' }));
          return;
        }
        
        if (failureMode === 'full') {
          // Simulate restaurant full
          console.log(`[MockTableStack] Returning 'full' status for ${req.url}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            reason: 'NO_TABLES_AVAILABLE',
            availableTables: 0,
            nextAvailableSlot: '2 hours',
          }));
          return;
        }
      }
      
      // Normal response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        reservationId: 'mock-reservation-' + randomUUID(),
        confirmed: true,
      }));
    });

    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`[MockTableStack] Server started on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log(`[MockTableStack] Server stopped. Total requests: ${this.requestCount}, Blocked: ${this.blockedCount}`);
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  setBlockRequests(block: boolean): void {
    this.blockRequests = block;
    console.log(`[MockTableStack] Block requests: ${block}`);
  }

  getStats(): { requestCount: number; blockedCount: number } {
    return {
      requestCount: this.requestCount,
      blockedCount: this.blockedCount,
    };
  }

  resetStats(): void {
    this.requestCount = 0;
    this.blockedCount = 0;
  }
}

// ============================================================================
// TEST SCENARIOS
// ============================================================================

const SCENARIOS: FailoverTestScenario[] = [
  {
    name: 'API Timeout Failover',
    description: 'TableStack API times out - agent should suggest delivery',
    userInput: 'Book a table for 2 at Test Restaurant tonight at 7pm',
    expectedFailoverType: 'DELIVERY',
    setup: async () => {
      console.log('[Scenario] Setting up API timeout...');
    },
    cleanup: async () => {
      console.log('[Scenario] Cleaning up timeout test...');
    },
  },
  {
    name: 'Restaurant Full Failover',
    description: 'Restaurant reports no tables - agent should suggest alternatives',
    userInput: 'I want to reserve a table for 4 at Test Restaurant this Friday',
    expectedFailoverType: 'ALTERNATIVE_TIME',
    setup: async () => {
      console.log('[Scenario] Setting up restaurant full response...');
    },
    cleanup: async () => {
      console.log('[Scenario] Cleaning up full restaurant test...');
    },
  },
  {
    name: 'Service Unavailable Failover',
    description: 'TableStack returns 503 - agent should failover gracefully',
    userInput: 'Make a reservation at Test Restaurant for tomorrow lunch',
    expectedFailoverType: 'DELIVERY',
    setup: async () => {
      console.log('[Scenario] Setting up 503 error...');
    },
    cleanup: async () => {
      console.log('[Scenario] Cleaning up 503 test...');
    },
  },
];

// ============================================================================
// TEST EXECUTION
// ============================================================================

async function executeFailoverTest(
  scenario: FailoverTestScenario,
  mockServer: MockTableStackServer
): Promise<FailoverTestResult> {
  const startTime = Date.now();
  const executionId = randomUUID();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${scenario.name}`);
  console.log(`Description: ${scenario.description}`);
  console.log(`Expected Failover: ${scenario.expectedFailoverType}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // Setup scenario-specific mocking
    await scenario.setup();

    // Send chat request to intention engine
    const chatResponse = await fetch(`${CONFIG.intentionEngineUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-clerk-id': CONFIG.testUserId,
      },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: scenario.userInput,
          },
        ],
      }),
    });

    const latencyMs = Date.now() - startTime;

    if (!chatResponse.ok) {
      const errorText = await chatResponse.text();
      return {
        scenario: scenario.name,
        success: false,
        latencyMs,
        llmCorrections: 0,
        policyTriggers: [],
        error: `Chat request failed: ${chatResponse.status} ${errorText}`,
      };
    }

    const chatData = await chatResponse.json();

    // Analyze response for failover behavior
    const analysis = analyzeFailoverResponse(chatData, scenario.expectedFailoverType);

    // Cleanup
    await scenario.cleanup();

    return {
      scenario: scenario.name,
      success: analysis.detected,
      actualFailoverType: analysis.detectedType,
      latencyMs,
      llmCorrections: analysis.llmCorrections,
      policyTriggers: analysis.policyTriggers,
      trace: {
        executionId: chatData.executionId || executionId,
        traceId: chatData.traceId || executionId,
      },
    };
  } catch (error) {
    await scenario.cleanup();
    
    return {
      scenario: scenario.name,
      success: false,
      latencyMs: Date.now() - startTime,
      llmCorrections: 0,
      policyTriggers: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Analyze chat response for failover behavior
 */
function analyzeFailoverResponse(
  chatData: any,
  expectedType: string
): {
  detected: boolean;
  detectedType?: string;
  llmCorrections: number;
  policyTriggers: string[];
} {
  const responseText = JSON.stringify(chatData).toLowerCase();
  
  // Detect failover types
  const failoverIndicators: Record<string, RegExp[]> = {
    'DELIVERY': [
      /delivery/i,
      /deliver/i,
      /open.?delivery/i,
      /order.*food/i,
      /have.*delivered/i,
    ],
    'WAITLIST': [
      /waitlist/i,
      /join.*wait/i,
      /wait.*list/i,
      /notify.*available/i,
    ],
    'ALTERNATIVE_TIME': [
      /alternative.*time/i,
      /different.*time/i,
      /how about.*[0-9]/i,
      /available.*[0-9].*pm/i,
      /available.*[0-9].*am/i,
    ],
    'ALTERNATIVE_RESTAURANT': [
      /alternative.*restaurant/i,
      /different.*restaurant/i,
      /nearby.*restaurant/i,
      /similar.*restaurant/i,
    ],
  };

  let detectedType: string | undefined;
  for (const [type, patterns] of Object.entries(failoverIndicators)) {
    if (patterns.some(p => p.test(responseText))) {
      detectedType = type;
      break;
    }
  }

  // Detect LLM corrections (circuit breaker activations)
  const llmCorrections = (responseText.match(/correction/g) || []).length +
                         (responseText.match(/retry/g) || []).length +
                         (responseText.match(/attempt/g) || []).length;

  // Detect policy triggers
  const policyTriggers: string[] = [];
  if (responseText.includes('suggest_alternative_time')) policyTriggers.push('SUGGEST_ALTERNATIVE_TIME');
  if (responseText.includes('trigger_delivery')) policyTriggers.push('TRIGGER_DELIVERY');
  if (responseText.includes('trigger_waitlist')) policyTriggers.push('TRIGGER_WAITLIST');
  if (responseText.includes('suggest_alternative_restaurant')) policyTriggers.push('SUGGEST_ALTERNATIVE_RESTAURANT');

  return {
    detected: detectedType === expectedType,
    detectedType,
    llmCorrections,
    policyTriggers,
  };
}

// ============================================================================
// MAIN TEST RUNNER
// ============================================================================

async function runFailoverTests(): Promise<void> {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                    AUTOMATED A/B FAILOVER TEST SUITE                         ║
╠══════════════════════════════════════════════════════════════════════════════╣
║ Intention Engine: ${CONFIG.intentionEngineUrl}
║ TableStack Mock:  ${CONFIG.tableStackUrl}
║ Timeout:          ${CONFIG.timeout}ms
║ Verbose:          ${CONFIG.verbose}
╚══════════════════════════════════════════════════════════════════════════════╝
`);

  const mockServer = new MockTableStackServer(49160);
  
  try {
    // Start mock server
    await mockServer.start();

    // Update environment to use mock server
    process.env.TABLESTACK_URL = `http://localhost:${mockServer.port}`;

    const results: FailoverTestResult[] = [];

    // Run each scenario with different failure modes
    for (const failureMode of ['timeout', '503', 'full']) {
      console.log(`\n${'🔴'.repeat(20)}`);
      console.log(`FAILURE MODE: ${failureMode.toUpperCase()}`);
      console.log(`${'🔴'.repeat(20)}\n`);

      process.env.FAILURE_MODE = failureMode;
      mockServer.setBlockRequests(true);
      mockServer.resetStats();

      for (const scenario of SCENARIOS) {
        const result = await executeFailoverTest(scenario, mockServer);
        results.push(result);

        // Print result
        const status = result.success ? '✅ PASS' : '❌ FAIL';
        console.log(`\n${status} ${result.scenario}`);
        console.log(`   Latency: ${result.latencyMs}ms`);
        if (result.actualFailoverType) {
          console.log(`   Actual Failover: ${result.actualFailoverType}`);
        }
        if (result.llmCorrections > 0) {
          console.log(`   LLM Corrections: ${result.llmCorrections}`);
        }
        if (result.policyTriggers.length > 0) {
          console.log(`   Policy Triggers: ${result.policyTriggers.join(', ')}`);
        }
        if (result.error) {
          console.log(`   Error: ${result.error}`);
        }
        if (result.trace) {
          console.log(`   Trace: ${result.trace.traceId}`);
        }
      }
    }

    // Print summary
    printTestSummary(results);

  } finally {
    // Cleanup
    await mockServer.stop();
  }
}

/**
 * Print test summary report
 */
function printTestSummary(results: FailoverTestResult[]): void {
  const total = results.length;
  const passed = results.filter(r => r.success).length;
  const failed = total - passed;
  const passRate = ((passed / total) * 100).toFixed(1);

  const avgLatency = results.reduce((sum, r) => sum + r.latencyMs, 0) / total;
  const totalLlmCorrections = results.reduce((sum, r) => sum + (r.llmCorrections || 0), 0);

  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                           TEST SUMMARY REPORT                                ║
╠══════════════════════════════════════════════════════════════════════════════╣
║ Total Tests:     ${total}
║ Passed:          ${passed} ✅
║ Failed:          ${failed} ${failed > 0 ? '❌' : ''}
║ Pass Rate:       ${passRate}%
╠══════════════════════════════════════════════════════════════════════════════╣
║ Average Latency:        ${avgLatency.toFixed(0)}ms
║ Total LLM Corrections:  ${totalLlmCorrections}
╚══════════════════════════════════════════════════════════════════════════════╝
`);

  // Detailed results table
  console.log('\n📊 DETAILED RESULTS:\n');
  console.log('┌──────────────────────────────────────┬──────────┬────────────┬─────────────┬──────────────┐');
  console.log('│ Scenario                           │ Status   │ Latency    │ Failover    │ Corrections  │');
  console.log('├──────────────────────────────────────┼──────────┼────────────┼─────────────┼──────────────┤');

  for (const result of results) {
    const status = result.success ? '✅ PASS' : '❌ FAIL';
    const failoverType = result.actualFailoverType || 'None';
    
    console.log(
      `│ ${result.scenario.padEnd(36)} │ ${status.padEnd(8)} │ ${String(result.latencyMs).padEnd(10)} │ ${failoverType.padEnd(11)} │ ${String(result.llmCorrections).padEnd(12)} │`
    );
  }

  console.log('└──────────────────────────────────────┴──────────┴────────────┴─────────────┴──────────────┘');

  // Recommendations
  if (failed > 0) {
    console.log('\n⚠️  RECOMMENDATIONS:\n');
    
    const failedScenarios = results.filter(r => !r.success);
    for (const result of failedScenarios) {
      console.log(`• ${result.scenario}: ${result.error || 'Failover not detected'}`);
    }
    
    console.log('\n💡 Tips:');
    console.log('   - Ensure FailoverPolicyEngine is properly configured');
    console.log('   - Check that LLM has failover instructions in system prompt');
    console.log('   - Verify LiveOperationalState cache is populated');
    console.log('   - Review circuit breaker thresholds');
  } else {
    console.log('\n✅ All failover tests passed! Your agent is resilient.\n');
  }

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

// ============================================================================
// ENTRY POINT
// ============================================================================

runFailoverTests().catch((error) => {
  console.error('Fatal error running failover tests:', error);
  process.exit(1);
});
