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

// Custom metrics
const errorRate = new Rate("errors");
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
    http_req_failed: ["rate<0.25"],    // Error rate under 25%
    checks: ["rate>=0.85"],            // 85% of checks must pass
    errors: ["rate<0.30"],             // Error rate under 30%
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  const executionId = `chaos-db-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Test 1: Read operation (should use read replica or cache)
  const readResponse = http.get(
    `${BASE_URL}/api/restaurants?search=tokyo`,
    {
      headers: { "Content-Type": "application/json" },
      timeout: "5s",
      tags: { name: "db_read" },
    }
  );

  const readCheck = check(readResponse, {
    "read: status is 200, 404, or 503": (r) =>
      [200, 404, 503].includes(r.status),
    "read: graceful degradation on DB failure": (r) => {
      if (r.status === 503) {
        const body = JSON.parse(r.body || "{}");
        return body.error?.includes("database") || body.fallback === true;
      }
      if (r.status === 200) {
        const body = JSON.parse(r.body || "{}");
        return Array.isArray(body.restaurants) || body.data;
      }
      return true;
    },
  });

  errorRate.add(!readCheck);

  sleep(0.5);

  // Test 2: Write operation (should have retry logic)
  const writePayload = {
    user_id: "test-user",
    restaurant_id: "test-restaurant",
    date: "2025-12-25",
    time: "19:00",
    party_size: 2,
  };

  const writeResponse = http.post(
    `${BASE_URL}/api/reservations`,
    JSON.stringify(writePayload),
    {
      headers: { "Content-Type": "application/json" },
      timeout: "8s",
      tags: { name: "db_write" },
    }
  );

  const writeCheck = check(writeResponse, {
    "write: status is 200, 201, 409, or 503": (r) =>
      [200, 201, 409, 503].includes(r.status),
    "write: proper error on DB failure": (r) => {
      if (r.status === 503) {
        const body = JSON.parse(r.body || "{}");
        return body.error?.includes("database") || body.retry_after;
      }
      if ([200, 201].includes(r.status)) {
        const body = JSON.parse(r.body || "{}");
        return body.reservation_id || body.id;
      }
      return true;
    },
  });

  retryRate.add(writeResponse.headers?.["x-retry-count"] !== undefined);
  errorRate.add(!writeCheck);

  sleep(1);

  // Test 3: Health check endpoint
  const healthResponse = http.get(
    `${BASE_URL}/api/health`,
    {
      timeout: "2s",
      tags: { name: "health_check" },
    }
  );

  check(healthResponse, {
    "health: returns status": (r) => r.status === 200 || r.status === 503,
    "health: includes DB status": (r) => {
      const body = JSON.parse(r.body || "{}");
      return body.database !== undefined || body.services?.database;
    },
  });

  sleep(0.5);
}

export function handleSummary(data) {
  const { metrics } = data;
  const checks = metrics.checks?.values || {};

  return {
    stdout: `
Chaos Test Results - Database Failure:
  Pass Rate: ${(checks.rate || 0 * 100).toFixed(2)}%
  Error Rate: ${(metrics.http_req_failed?.values?.rate || 0 * 100).toFixed(2)}%
  Retry Rate: ${(metrics.retries?.values?.rate || 0 * 100).toFixed(2)}%
`,
  };
}
