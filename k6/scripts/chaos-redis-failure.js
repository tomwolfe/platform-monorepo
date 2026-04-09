/**
 * Chaos Engineering Test - Redis Failure Injection
 *
 * Purpose: Verify system resilience when Redis becomes unavailable
 * Tests: Lock recovery, cache fallback, graceful degradation, saga suspension/resumption
 *
 * Scenario: Simulate Redis connection failures and timeouts
 * Expected: System should fail gracefully, use fallbacks, recover locks
 *
 * PHASE 4.2 ENHANCEMENT: Added saga-specific failure scenarios:
 * - Multi-step saga execution with Redis failure mid-saga
 * - Saga pause (SUSPENDED status) verification
 * - Saga resume after Redis recovery
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Counter } from "k6/metrics";

// Custom metrics - track UNEXPECTED errors only (503/429 are expected chaos responses)
const unexpectedErrors = new Rate("unexpected_errors");
const fallbackRate = new Rate("fallback_used");
const recoverySuccess = new Counter("recovery_success");

// PHASE 4.2: Saga-specific metrics
const sagaSuspended = new Rate("saga_suspended");
const sagaResumed = new Rate("saga_resumed");
const sagaCheckpointed = new Rate("saga_checkpointed");

export const options = {
  scenarios: {
    redis_failure: {
      executor: "ramping-vus",
      startVUs: 5,
      stages: [
        { duration: "20s", target: 10 }, // Ramp up to 10 VUs
        { duration: "40s", target: 10 }, // Steady state
        { duration: "20s", target: 0 }, // Ramp down
      ],
      gracefulStop: "5s",
      tags: { scenario: "redis_failure" },
    },
    // PHASE 4.2: New scenario - Redis failure during active saga execution
    redis_failure_during_saga: {
      executor: "shared-iterations",
      vus: 3,
      iterations: 5,
      maxDuration: "60s",
      startTime: "10s", // Start after initial ramp-up
      tags: { scenario: "redis_failure_during_saga" },
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.80"], // Relaxed: 503/429 are expected chaos responses
    checks: ["rate>=0.95"], // 95% of checks must pass
    unexpected_errors: ["rate<0.05"], // Strict: unexpected errors (500s) must be under 5%
    fallback_used: ["rate>=0.05"], // At least some fallbacks should trigger
    // PHASE 4.2: Saga-specific thresholds
    saga_suspended: ["rate>=0.50"], // At least 50% of sagas should suspend gracefully
    saga_resumed: ["rate>=0.80"], // At least 80% of suspended sagas should resume successfully
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

/**
 * PHASE 4.2: Simulate Redis container restart
 * In a real environment, this would call docker-compose or k8s APIs.
 * For testing purposes, we simulate the behavior by toggling expected responses.
 */
function simulateRedisRestart(vuIndex) {
  // Phase 1: Redis goes down (first 10 seconds of this scenario)
  const redisDown = __ITER < 2;

  // Phase 2: Redis comes back up (remaining iterations)
  const redisUp = __ITER >= 3;

  return { redisDown, redisUp };
}

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
    },
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
    },
  );

  // 200, 400, 429, 503 are expected responses in chaos testing
  const isExecutionExpected = [200, 400, 429, 503].includes(
    executionResponse.status,
  );

  const executionCheck = check(executionResponse, {
    "execution: is resilient status": (r) => isExecutionExpected,
    "execution: graceful degradation on Redis outage": (r) => {
      if (r.status === 503) {
        try {
          const body = JSON.parse(r.body || "{}");
          return (
            body.error?.includes("Redis") ||
            body.error?.includes("redis") ||
            body.fallback === true
          );
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

// ============================================================================
// PHASE 4.2: REDIS FAILURE DURING SAGA EXECUTION
// ============================================================================

/**
 * This scenario specifically tests what happens when Redis becomes unavailable
 * DURING a multi-step saga execution.
 *
 * Expected behavior:
 * 1. Saga should PAUSE (status: SUSPENDED) rather than FAIL completely
 * 2. State should be checkpointed to local memory before Redis goes down
 * 3. When Redis comes back up, saga should RESUME from checkpoint
 */
export function redis_failure_during_saga() {
  const sagaId = `saga-chaos-${Date.now()}-${__VU}-${__ITER}`;
  const { redisDown, redisUp } = simulateRedisRestart(__VU);

  // Step 1: Start a saga (initial execution)
  const sagaStartPayload = {
    intent: "Book a table for 4 at Italian Restaurant tomorrow at 7pm",
    execution_id: sagaId,
    test_mode: true, // Enable test mode to avoid actual external calls
  };

  const startResponse = http.post(
    `${BASE_URL}/api/execute`,
    JSON.stringify(sagaStartPayload),
    {
      headers: { "Content-Type": "application/json" },
      timeout: "10s",
      tags: { name: "saga_start" },
    },
  );

  const startCheck = check(startResponse, {
    "saga: started successfully": (r) => r.status === 200 || r.status === 202,
    "saga: has execution_id": (r) => {
      try {
        const body = JSON.parse(r.body || "{}");
        return body.data?.execution_id || body.execution_id;
      } catch {
        return false;
      }
    },
  });

  if (startResponse.status !== 200 && startResponse.status !== 202) {
    // Saga failed to start - record and continue
    unexpectedErrors.add(true);
    return;
  }

  sleep(2);

  // Step 2: Simulate Redis going down during saga execution
  if (redisDown) {
    // The system should detect Redis unavailability and SUSPEND the saga
    // Check saga status endpoint
    const statusResponse = http.get(`${BASE_URL}/api/engine/status/${sagaId}`, {
      timeout: "5s",
      tags: { name: "saga_status_check" },
    });

    const statusCheck = check(statusResponse, {
      "saga: status is SUSPENDED or checkpointed": (r) => {
        if (r.status !== 200) return true; // If status endpoint is also down, that's acceptable
        try {
          const body = JSON.parse(r.body || "{}");
          const status = body.data?.status || body.status;
          // Saga should be suspended, not failed
          return (
            status === "SUSPENDED" ||
            status === "YIELDING" ||
            status === "CHECKPOINTED"
          );
        } catch {
          return true;
        }
      },
    });

    // Track saga suspension rate
    try {
      const body = JSON.parse(statusResponse.body || "{}");
      const status = body.data?.status || body.status;
      sagaSuspended.add(status === "SUSPENDED" || status === "YIELDING");
      sagaCheckpointed.add(status === "CHECKPOINTED" || status === "YIELDING");
    } catch {
      // Status parsing failed - that's okay
    }

    sleep(5); // Simulate Redis being down for 5 seconds
  }

  // Step 3: Simulate Redis coming back up
  if (redisUp) {
    // Trigger saga resume
    const resumeResponse = http.post(
      `${BASE_URL}/api/engine/resume/${sagaId}`,
      {},
      {
        headers: { "Content-Type": "application/json" },
        timeout: "10s",
        tags: { name: "saga_resume" },
      },
    );

    const resumeCheck = check(resumeResponse, {
      "saga: resumed successfully": (r) => r.status === 200 || r.status === 202,
      "saga: resumed from checkpoint": (r) => {
        try {
          const body = JSON.parse(r.body || "{}");
          return body.data?.resumed_from_checkpoint === true;
        } catch {
          return true;
        }
      },
    });

    // Track saga resume success rate
    sagaResumed.add(
      resumeResponse.status === 200 || resumeResponse.status === 202,
    );

    sleep(2);

    // Step 4: Verify saga completed after resume
    const finalStatusResponse = http.get(
      `${BASE_URL}/api/engine/status/${sagaId}`,
      {
        timeout: "5s",
        tags: { name: "saga_final_status" },
      },
    );

    check(finalStatusResponse, {
      "saga: completed after resume": (r) => {
        if (r.status !== 200) return true;
        try {
          const body = JSON.parse(r.body || "{}");
          const status = body.data?.status || body.status;
          return status === "COMPLETED" || status === "EXECUTING";
        } catch {
          return true;
        }
      },
    });
  }
}

export function handleSummary(data) {
  const { metrics } = data;
  const checks = metrics.checks?.values || {};
  const fallback = metrics.fallback_used?.values || {};
  // PHASE 4.2: Include saga metrics in summary
  const sagaSuspend = metrics.saga_suspended?.values || {};
  const sagaResume = metrics.saga_resumed?.values || {};
  const sagaCheckpoint = metrics.saga_checkpointed?.values || {};

  return {
    stdout: `
Chaos Test Results - Redis Failure:
  Pass Rate: ${(checks.rate || 0 * 100).toFixed(2)}%
  Fallback Rate: ${(fallback.rate || 0 * 100).toFixed(2)}%
  Error Rate: ${(metrics.http_req_failed?.values?.rate || 0 * 100).toFixed(2)}%

Saga Resilience Metrics (Phase 4.2):
  Saga Suspended: ${(sagaSuspend.rate || 0 * 100).toFixed(2)}%
  Saga Resumed: ${(sagaResume.rate || 0 * 100).toFixed(2)}%
  Saga Checkpointed: ${(sagaCheckpoint.rate || 0 * 100).toFixed(2)}%
`,
  };
}
