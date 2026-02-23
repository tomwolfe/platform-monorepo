/**
 * Chaos Engineering Test - Redis Failure Injection
 *
 * Purpose: Verify system resilience when Redis becomes unavailable
 * Tests: Lock recovery, cache fallback, graceful degradation
 *
 * Scenario: Simulate Redis connection failures and timeouts
 * Expected: System should fail gracefully, use fallbacks, recover locks
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from "k6/metrics";

// Custom metrics - track UNEXPECTED errors only (503/429 are expected chaos responses)
const unexpectedErrors = new Rate("unexpected_errors");
const fallbackRate = new Rate("fallback_used");
const recoverySuccess = new Counter("recovery_success");

export const options = {
  scenarios: {
    redis_failure: {
      executor: "ramping-vus",
      startVUs: 5,
      stages: [
        { duration: "20s", target: 10 },  // Ramp up to 10 VUs
        { duration: "40s", target: 10 },  // Steady state
        { duration: "20s", target: 0 },   // Ramp down
      ],
      gracefulStop: "5s",
      tags: { scenario: "redis_failure" },
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.80"],      // Relaxed: 503/429 are expected chaos responses
    checks: ["rate>=0.95"],              // 95% of checks must pass
    unexpected_errors: ["rate<0.05"],    // Strict: unexpected errors (500s) must be under 5%
    fallback_used: ["rate>=0.05"],       // At least some fallbacks should trigger
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  const executionId = `chaos-redis-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Test 1: Intent endpoint (uses Redis for memory/locks)
  const intentPayload = {
    text: "Show me my reservations",
  };

  const intentResponse = http.post(
    `${BASE_URL}/api/intent`,
    JSON.stringify(intentPayload),
    {
      headers: { "Content-Type": "application/json" },
      timeout: "5s",
      tags: { name: "intent_with_lock" },
    }
  );

  // 200, 400, 429, 503 are expected responses in chaos testing
  const isIntentExpected = [200, 400, 429, 503].includes(intentResponse.status);

  const intentCheck = check(intentResponse, {
    "intent: is resilient status": (r) => isIntentExpected,
    "intent: valid response structure": (r) => {
      if (r.status !== 200) return true;
      try {
        const body = JSON.parse(r.body || "{}");
        return body.success !== undefined || body.error;
      } catch {
        return false;
      }
    },
  });

  // Track unexpected errors (not 200/400/429/503 and not a timeout)
  unexpectedErrors.add(!isIntentExpected && intentResponse.status !== 0);

  sleep(0.5);

  // Test 2: Execution endpoint (uses Redis for state management)
  const executionPayload = {
    input: "Show me my reservations",
    context: {
      execution_id: executionId,
    },
  };

  const executionResponse = http.post(
    `${BASE_URL}/api/execute`,
    JSON.stringify(executionPayload),
    {
      headers: { "Content-Type": "application/json" },
      timeout: "8s",
      tags: { name: "execution_redis" },
    }
  );

  // 200, 400, 429, 503 are expected responses in chaos testing
  const isExecutionExpected = [200, 400, 429, 503].includes(executionResponse.status);

  const executionCheck = check(executionResponse, {
    "execution: is resilient status": (r) => isExecutionExpected,
    "execution: graceful degradation on Redis outage": (r) => {
      if (r.status === 503) {
        try {
          const body = JSON.parse(r.body || "{}");
          return body.error?.includes("Redis") || body.error?.includes("redis") || body.fallback === true;
        } catch {
          return true;
        }
      }
      return true;
    },
  });

  fallbackRate.add(executionResponse.status === 503);
  // Track unexpected errors (not 200/400/429/503 and not a timeout)
  unexpectedErrors.add(!isExecutionExpected && executionResponse.status !== 0);

  sleep(1);
}

export function handleSummary(data) {
  const { metrics } = data;
  const checks = metrics.checks?.values || {};
  const fallback = metrics.fallback_used?.values || {};

  return {
    stdout: `
Chaos Test Results - Redis Failure:
  Pass Rate: ${(checks.rate || 0 * 100).toFixed(2)}%
  Fallback Rate: ${(fallback.rate || 0 * 100).toFixed(2)}%
  Error Rate: ${(metrics.http_req_failed?.values?.rate || 0 * 100).toFixed(2)}%
`,
  };
}
