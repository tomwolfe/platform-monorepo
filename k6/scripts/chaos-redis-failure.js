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

// Custom metrics
const errorRate = new Rate("errors");
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
    http_req_failed: ["rate<0.2"],    // Error rate under 20%
    checks: ["rate>=0.90"],           // 90% of checks must pass
    errors: ["rate<0.25"],            // Error rate under 25%
    fallback_used: ["rate>=0.05"],    // At least some fallbacks should trigger
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  const executionId = `chaos-redis-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Test 1: Lock acquisition endpoint (simulated)
  const lockResponse = http.post(
    `${BASE_URL}/api/engine/lock`,
    JSON.stringify({
      execution_id: executionId,
      resource: `test:${executionId}`,
      ttl_seconds: 30,
    }),
    {
      headers: { "Content-Type": "application/json" },
      timeout: "3s",
      tags: { name: "lock_acquire" },
    }
  );

  const lockCheck = check(lockResponse, {
    "lock: status is 200, 409, or 503": (r) =>
      [200, 409, 503].includes(r.status),
    "lock: graceful failure on Redis outage": (r) => {
      if (r.status === 503) {
        const body = JSON.parse(r.body || "{}");
        return body.error?.includes("Redis") || body.error?.includes("lock");
      }
      return true;
    },
  });

  fallbackRate.add(lockResponse.status === 503);
  errorRate.add(!lockCheck);

  sleep(0.3);

  // Test 2: Execution with potential lock contention
  const intentPayload = {
    user_input: "Show me my reservations",
    execution_id: executionId,
  };

  const intentResponse = http.post(
    `${BASE_URL}/api/intent/parse`,
    JSON.stringify(intentPayload),
    {
      headers: { "Content-Type": "application/json" },
      timeout: "5s",
      tags: { name: "intent_with_lock" },
    }
  );

  const intentCheck = check(intentResponse, {
    "intent: status is 200, 429, or 503": (r) =>
      [200, 429, 503].includes(r.status),
    "intent: valid response structure": (r) => {
      if (r.status !== 200) return true;
      const body = JSON.parse(r.body || "{}");
      return body.intent_id || body.intent?.type;
    },
  });

  errorRate.add(!intentCheck);

  sleep(0.5);

  // Test 3: Cache read with Redis failure
  const cacheResponse = http.get(
    `${BASE_URL}/api/cache/user/test-user`,
    {
      headers: { "Content-Type": "application/json" },
      timeout: "2s",
      tags: { name: "cache_read" },
    }
  );

  const cacheCheck = check(cacheResponse, {
    "cache: status is 200, 404, or 503": (r) =>
      [200, 404, 503].includes(r.status),
    "cache: graceful degradation": (r) => {
      if (r.status === 503) {
        const body = JSON.parse(r.body || "{}");
        return body.error?.includes("cache") || body.fallback === true;
      }
      return true;
    },
  });

  fallbackRate.add(cacheResponse.status === 503);
  errorRate.add(!cacheCheck);

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
