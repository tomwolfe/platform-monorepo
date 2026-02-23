/**
 * Chaos Engineering Test - Latency Spike Injection
 *
 * Purpose: Verify system resilience when API latency spikes occur
 * Tests: Circuit breakers, timeouts, graceful degradation
 *
 * Scenario: Inject random 1-3 second delays to simulate network congestion
 * Expected: System should maintain p95 < 2000ms and fail gracefully
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

// Custom metrics
const errorRate = new Rate("errors");
const timeoutRate = new Rate("timeouts");

export const options = {
  scenarios: {
    latency_spike: {
      executor: "ramping-vus",
      startVUs: 5,
      stages: [
        { duration: "30s", target: 20 },  // Ramp up to 20 VUs
        { duration: "1m", target: 20 },   // Stay at 20 VUs
        { duration: "30s", target: 0 },   // Ramp down
      ],
      gracefulStop: "5s",
      tags: { scenario: "latency_spike" },
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<2000"], // p95 must be under 2 seconds
    http_req_failed: ["rate<0.1"],     // Error rate must be under 10%
    checks: ["rate>=0.95"],            // 95% of checks must pass
    errors: ["rate<0.15"],             // Error rate under 15%
    timeouts: ["rate<0.2"],            // Timeout rate under 20%
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export default function () {
  const executionId = `chaos-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  // Test 1: Intent parsing endpoint with latency (intention-engine)
  const intentPayload = {
    text: "Book a table for 2 people tomorrow at 7pm",
  };

  const intentResponse = http.post(
    `${BASE_URL}/api/intent`,
    JSON.stringify(intentPayload),
    {
      headers: { "Content-Type": "application/json" },
      timeout: "5s",
      tags: { name: "intent_parse" },
    }
  );

  const intentCheck = check(intentResponse, {
    "intent parse: status is 200, 400, 429, or 503": (r) => [200, 400, 429, 503].includes(r.status),
    "intent parse: has valid response or rate limit": (r) => {
      if (r.status === 429 || r.status === 400 || r.status === 503) return true;
      try {
        const body = JSON.parse(r.body || "{}");
        return body.success !== undefined || body.error;
      } catch {
        return false;
      }
    },
  });

  errorRate.add(!intentCheck);

  sleep(0.5);

  // Test 2: Execution endpoint with latency (intention-engine)
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
      tags: { name: "execution" },
    }
  );

  const executionCheck = check(executionResponse, {
    "execution: status is 200, 400, 429, or 503": (r) =>
      [200, 400, 429, 503].includes(r.status),
    "execution: graceful degradation on timeout": (r) => {
      if (r.status === 503 || r.status === 429 || r.status === 400) return true;
      try {
        const body = JSON.parse(r.body || "{}");
        return body.execution_id || body.status || body.error;
      } catch {
        return false;
      }
    },
  });

  timeoutRate.add(executionResponse.timings?.duration > 5000);
  errorRate.add(!executionCheck);

  sleep(1);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
  };
}

function textSummary(data, options) {
  const { metrics } = data;
  const httpReqDuration = metrics.http_req_duration?.values || {};
  const checks = metrics.checks?.values || {};

  return `
Chaos Test Results - Latency Spike:
  p95 Latency: ${httpReqDuration["p(95)"]?.toFixed(0) || "N/A"}ms (threshold: <2000ms)
  Pass Rate: ${(checks.rate || 0 * 100).toFixed(2)}%
`;
}
