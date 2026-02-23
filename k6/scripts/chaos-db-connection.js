/**
 * Chaos Engineering Test - Database Connection Failure
 *
 * Purpose: Verify system resilience when PostgreSQL becomes unavailable
 * Tests: Connection pooling, retry logic, graceful degradation
 *
 * Scenario: Simulate database connection failures and slow queries
 * Expected: System should retry appropriately, fail gracefully, use read replicas
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

// Custom metrics - track UNEXPECTED errors only (503/429 are expected chaos responses)
const unexpectedErrors = new Rate("unexpected_errors");
const retryRate = new Rate("retries");

export const options = {
  scenarios: {
    db_failure: {
      executor: "ramping-vus",
      startVUs: 5,
      stages: [
        { duration: "20s", target: 15 },  // Ramp up to 15 VUs
        { duration: "40s", target: 15 },  // Steady state
        { duration: "20s", target: 0 },   // Ramp down
      ],
      gracefulStop: "5s",
      tags: { scenario: "db_failure" },
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.80"],      // Relaxed: 503/429 are expected chaos responses
    checks: ["rate>=0.95"],              // 95% of checks must pass
    unexpected_errors: ["rate<0.05"],    // Strict: unexpected errors (500s) must be under 5%
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  const executionId = `chaos-db-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Test 1: Intent endpoint (uses database for audit logs)
  const intentPayload = {
    text: "Book a table for 2 people tomorrow at 7pm",
  };

  const intentResponse = http.post(
    `${BASE_URL}/api/intent`,
    JSON.stringify(intentPayload),
    {
      headers: { "Content-Type": "application/json" },
      timeout: "5s",
      tags: { name: "db_intent" },
    }
  );

  // 200, 400, 429, 503 are expected responses in chaos testing
  const isIntentExpected = [200, 400, 429, 503].includes(intentResponse.status);

  const intentCheck = check(intentResponse, {
    "intent: is resilient status": (r) => isIntentExpected,
    "intent: graceful degradation on DB failure": (r) => {
      if (r.status === 503) {
        try {
          const body = JSON.parse(r.body || "{}");
          return body.error?.includes("database") || body.error?.includes("postgres") || body.fallback === true;
        } catch {
          return true;
        }
      }
      if (r.status === 200) {
        try {
          const body = JSON.parse(r.body || "{}");
          return body.success !== undefined;
        } catch {
          return false;
        }
      }
      return true;
    },
  });

  // Track unexpected errors (not 200/400/429/503 and not a timeout)
  unexpectedErrors.add(!isIntentExpected && intentResponse.status !== 0);

  sleep(0.5);

  // Test 2: Execution endpoint (uses database for state persistence)
  const executionPayload = {
    input: "Book a table for 2 people tomorrow at 7pm",
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
      tags: { name: "db_execution" },
    }
  );

  // 200, 400, 429, 503 are expected responses in chaos testing
  const isExecutionExpected = [200, 400, 429, 503].includes(executionResponse.status);

  const executionCheck = check(executionResponse, {
    "execution: is resilient status": (r) => isExecutionExpected,
    "execution: proper error on DB failure": (r) => {
      if (r.status === 503) {
        try {
          const body = JSON.parse(r.body || "{}");
          return body.error?.includes("database") || body.error?.includes("postgres") || body.retry_after;
        } catch {
          return true;
        }
      }
      if (r.status === 200) {
        try {
          const body = JSON.parse(r.body || "{}");
          return body.execution_id || body.status;
        } catch {
          return false;
        }
      }
      return true;
    },
  });

  retryRate.add(executionResponse.headers?.["x-retry-count"] !== undefined);
  // Track unexpected errors (not 200/400/429/503 and not a timeout)
  unexpectedErrors.add(!isExecutionExpected && executionResponse.status !== 0);

  sleep(1);
}

export function handleSummary(data) {
  const { metrics } = data;
  const checks = metrics.checks?.values || {};

  return {
    stdout: `
Chaos Test Results - Database Failure:
  Pass Rate: ${(checks.rate || 0 * 100).toFixed(2)}%
  Error Rate: ${(metrics.http_req_failed?.values?.rate || 0 * 100).toFixed(2)}%
`,
  };
}
