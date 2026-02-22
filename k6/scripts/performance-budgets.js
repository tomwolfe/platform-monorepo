/**
 * K6 Performance Testing Suite
 *
 * Performance Budgets (enforced in CI):
 * - Intent Inference P95 < 800ms
 * - Step Execution P95 < 2s
 * - Chat Response P95 < 1.5s
 * - Error Rate < 1%
 *
 * Usage:
 *   k6 run k6/scripts/intent-inference.js
 *   k6 run k6/scripts/step-execution.js
 *   k6 run k6/scripts/chat-response.js
 *   k6 run k6/scripts/all.js (run all tests)
 *
 * CI Integration:
 *   pnpm test:performance
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';

// ============================================================================
// CUSTOM METRICS
// ============================================================================

// Response time percentiles
const intentInferenceLatency = new Trend('intent_inference_latency', true);
const stepExecutionLatency = new Trend('step_execution_latency', true);
const chatResponseLatency = new Trend('chat_response_latency', true);

// Counters
const requestsTotal = new Counter('requests_total');
const errorsTotal = new Counter('errors_total');

// Error rate
const errorRate = new Rate('error_rate');

// ============================================================================
// CONFIGURATION
// ============================================================================

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const TEST_USER_ID = __ENV.TEST_USER_ID || 'k6-test-user';
const CLERK_ID = __ENV.CLERK_ID || 'test_clerk_id';

// Performance budgets (thresholds)
export const thresholds = {
  'intent_inference_latency': ['p(95)<800'], // P95 < 800ms
  'step_execution_latency': ['p(95)<2000'],  // P95 < 2s
  'chat_response_latency': ['p(95)<1500'],   // P95 < 1.5s
  'error_rate': ['rate<0.01'],               // < 1% errors
};

// Test scenarios
export const options = {
  thresholds,
  scenarios: {
    intent_inference: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 5 },   // Ramp up to 5 users
        { duration: '1m', target: 5 },    // Stay at 5 users
        { duration: '30s', target: 10 },  // Ramp up to 10 users
        { duration: '1m', target: 10 },   // Stay at 10 users
        { duration: '30s', target: 0 },   // Ramp down to 0 users
      ],
      graceRampDown: '30s',
      exec: 'intentInferenceTest',
      tags: { test_type: 'intent_inference' },
    },
    step_execution: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 3 },
        { duration: '1m', target: 3 },
        { duration: '30s', target: 5 },
        { duration: '1m', target: 5 },
        { duration: '30s', target: 0 },
      ],
      graceRampDown: '30s',
      exec: 'stepExecutionTest',
      tags: { test_type: 'step_execution' },
    },
    chat_response: {
      executor: 'constant-arrival-rate',
      rate: 10,            // 10 iterations per second
      duration: '2m',
      preAllocatedVUs: 20,
      maxVUs: 50,
      exec: 'chatResponseTest',
      tags: { test_type: 'chat_response' },
    },
  },
};

// ============================================================================
// SETUP AND TEARDOWN
// ============================================================================

export function setup() {
  console.log(`Starting performance tests against ${BASE_URL}`);
  
  // Health check
  const healthRes = http.get(`${BASE_URL}/api/health`, {
    headers: { 'Content-Type': 'application/json' },
  });
  
  if (!check(healthRes, { 'health check': (r) => r.status === 200 })) {
    console.warn('Health check failed, continuing anyway...');
  }
  
  return { startTime: Date.now() };
}

export function teardown(data) {
  const duration = Date.now() - data.startTime;
  console.log(`Performance tests completed in ${duration}ms`);
  console.log(`Total requests: ${requestsTotal.count}`);
  console.log(`Total errors: ${errorsTotal.count}`);
  console.log(`Error rate: ${(errorRate.rate * 100).toFixed(2)}%`);
}

// ============================================================================
// TEST SCENARIOS
// ============================================================================

/**
 * Intent Inference Test
 * Measures latency of intent parsing and planning
 */
export function intentInferenceTest() {
  const startTime = Date.now();
  requestsTotal.add(1);
  
  const payload = JSON.stringify({
    messages: [
      {
        role: 'user',
        content: 'Book a table for 4 people at an Italian restaurant tomorrow at 7pm',
      },
    ],
    userLocation: { lat: 40.7128, lng: -74.0060 },
  });
  
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User-Id': TEST_USER_ID,
      'X-Clerk-Id': CLERK_ID,
    },
    tags: { endpoint: 'intent_inference' },
  };
  
  const res = http.post(`${BASE_URL}/api/intent`, payload, params);
  
  const latency = Date.now() - startTime;
  intentInferenceLatency.add(latency);
  
  const success = check(res, {
    'intent inference status is 200': (r) => r.status === 200,
    'intent inference has valid response': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.intent && body.intent.type;
      } catch {
        return false;
      }
    },
    'intent inference latency < 800ms': (r) => latency < 800,
  });
  
  if (!success) {
    errorsTotal.add(1);
  }
  
  errorRate.add(!success);
  
  sleep(0.5);
}

/**
 * Step Execution Test
 * Measures latency of individual step execution
 */
export function stepExecutionTest() {
  const startTime = Date.now();
  requestsTotal.add(1);
  
  // Simulate step execution via webhook endpoint
  const payload = JSON.stringify({
    executionId: `k6-test-${Date.now()}`,
    stepIndex: 0,
    internalKey: __ENV.INTERNAL_SYSTEM_KEY || 'test-key',
  });
  
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-System-Key': __ENV.INTERNAL_SYSTEM_KEY || 'test-key',
      'X-Trace-Id': `k6-trace-${Date.now()}`,
    },
    tags: { endpoint: 'step_execution' },
  };
  
  const res = http.post(`${BASE_URL}/api/webhooks/execute-step`, payload, params);
  
  const latency = Date.now() - startTime;
  stepExecutionLatency.add(latency);
  
  const success = check(res, {
    'step execution status is 200 or 202': (r) => r.status === 200 || r.status === 202,
    'step execution latency < 2s': (r) => latency < 2000,
  });
  
  if (!success) {
    errorsTotal.add(1);
  }
  
  errorRate.add(!success);
  
  sleep(1);
}

/**
 * Chat Response Test
 * Measures end-to-end chat response latency
 */
export function chatResponseTest() {
  const startTime = Date.now();
  requestsTotal.add(1);
  
  const messages = [
    { role: 'user', content: 'What Italian restaurants are available near me?' },
  ];
  
  const payload = JSON.stringify({
    messages,
    userLocation: { lat: 40.7128, lng: -74.0060 },
  });
  
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-Test-User-Id': TEST_USER_ID,
      'X-Clerk-Id': CLERK_ID,
    },
    tags: { endpoint: 'chat_response' },
  };
  
  const res = http.post(`${BASE_URL}/api/chat`, payload, params);
  
  const latency = Date.now() - startTime;
  chatResponseLatency.add(latency);
  
  const success = check(res, {
    'chat response status is 200': (r) => r.status === 200,
    'chat response latency < 1.5s': (r) => latency < 1500,
  });
  
  if (!success) {
    errorsTotal.add(1);
  }
  
  errorRate.add(!success);
  
  sleep(0.2);
}
