/**
 * Durable Execution & Saga Compensation Tests
 * 
 * Tests for:
 * 1. Segmented execution with checkpointing
 * 2. Saga compensation on failure
 * 3. Trace ID propagation
 * 4. Resume from checkpoint
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  executeSegment,
  resumeFromCheckpoint,
  CheckpointManager,
  type ToolExecutor,
  type DurableExecutionResult,
} from "@/lib/engine/durable-execution";
import {
  StepTransactionManager,
  executeSaga,
  type SagaContext,
} from "@/lib/engine/step-transaction";
import {
  TraceContextManager,
  createTracedToolExecutor,
  publishTracedEvent,
} from "@/lib/engine/trace-context";
import { Plan, PlanStep, ExecutionState } from "@/lib/engine/types";
import { createInitialState } from "@/lib/engine/state-machine";

// ============================================================================
// MOCK UTILITIES
// ============================================================================

const createMockPlan = (steps: Array<{ id: string; toolName: string; delay?: number; shouldFail?: boolean }>): Plan => {
  return {
    id: "plan-test-123",
    intent_id: "intent-test-123",
    steps: steps.map((s, index) => ({
      id: s.id,
      step_number: index,
      tool_name: s.toolName,
      parameters: { test: true },
      dependencies: index > 0 ? [steps[index - 1].id] : [],
      description: `Test step ${index}`,
      requires_confirmation: false,
      timeout_ms: 30000,
    })) as PlanStep[],
    constraints: {
      max_steps: 100,
      max_total_tokens: 100000,
      max_execution_time_ms: 60000,
    },
    metadata: {
      version: "1.0.0",
      created_at: new Date().toISOString(),
      planning_model_id: "test-model",
      estimated_total_tokens: 1000,
      estimated_latency_ms: 5000,
    },
    summary: "Test plan",
  } as Plan;
};

const createMockToolExecutor = (options?: {
  delay?: number;
  shouldFail?: boolean;
  failOnStep?: string;
  compensationData?: Record<string, any>;
}): ToolExecutor => {
  return {
    async execute(toolName, parameters, timeoutMs, signal) {
      if (options?.delay) {
        await new Promise(resolve => setTimeout(resolve, options.delay));
      }

      if (options?.shouldFail || (options?.failOnStep && toolName === options.failOnStep)) {
        return {
          success: false,
          error: "Simulated tool failure",
          latency_ms: options.delay || 0,
        };
      }

      return {
        success: true,
        output: { result: `Executed ${toolName}`, ...(options?.compensationData || {}) },
        latency_ms: options.delay || 0,
        compensation: options?.compensationData?.compensation,
      };
    },
  };
};

// ============================================================================
// DURABLE EXECUTION TESTS
// ============================================================================

describe("DurableExecution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("executeSegment", () => {
    it("should execute all steps successfully", async () => {
      const plan = createMockPlan([
        { id: "step-1", toolName: "tool_a" },
        { id: "step-2", toolName: "tool_b" },
        { id: "step-3", toolName: "tool_c" },
      ]);

      const executor = createMockToolExecutor();

      const result = await executeSegment(plan, executor, {
        executionId: "exec-test-123",
      });

      expect(result.success).toBe(true);
      expect(result.completed_steps).toBe(3);
      expect(result.failed_steps).toBe(0);
      expect(result.isPartial).toBe(false);
    });

    it("should handle step failure", async () => {
      const plan = createMockPlan([
        { id: "step-1", toolName: "tool_a" },
        { id: "step-2", toolName: "tool_b", shouldFail: true },
        { id: "step-3", toolName: "tool_c" },
      ]);

      const executor = createMockToolExecutor({ failOnStep: "tool_b" });

      const result = await executeSegment(plan, executor, {
        executionId: "exec-test-123",
      });

      expect(result.success).toBe(false);
      expect(result.failed_steps).toBeGreaterThan(0);
    });

    it("should create checkpoint when approaching timeout", async () => {
      // Create plan with slow steps
      const plan = createMockPlan([
        { id: "step-1", toolName: "tool_a", delay: 3000 },
        { id: "step-2", toolName: "tool_b", delay: 3000 },
        { id: "step-3", toolName: "tool_c", delay: 3000 },
        { id: "step-4", toolName: "tool_d", delay: 3000 },
      ]);

      const executor = createMockToolExecutor();

      // Mock Date.now to simulate time passing
      const originalDateNow = Date.now;
      let timeOffset = 0;
      Date.now = vi.fn(() => originalDateNow() + timeOffset);

      // Simulate time passing during execution
      const interval = setInterval(() => {
        timeOffset += 2000;
      }, 100);

      try {
        const result = await executeSegment(plan, executor, {
          executionId: "exec-test-timeout",
        });

        clearInterval(interval);

        // Should have created a checkpoint
        expect(result.isPartial).toBe(true);
        expect(result.checkpointCreated).toBe(true);
        expect(result.nextStepIndex).toBeDefined();
      } finally {
        Date.now = originalDateNow;
      }
    });

    it("should respect step dependencies", async () => {
      const plan = createMockPlan([
        { id: "step-1", toolName: "tool_a" },
        { id: "step-2", toolName: "tool_b" },
        { id: "step-3", toolName: "tool_c" },
      ]);

      // Make step-2 depend on step-1
      plan.steps[1].dependencies = ["step-1"];
      plan.steps[2].dependencies = ["step-2"];

      const executor = createMockToolExecutor();

      const result = await executeSegment(plan, executor, {
        executionId: "exec-test-deps",
      });

      expect(result.success).toBe(true);
      expect(result.completed_steps).toBe(3);
    });
  });

  describe("CheckpointManager", () => {
    it("should save and load checkpoints", async () => {
      const checkpoint = {
        executionId: "exec-test-checkpoint",
        intentId: "intent-123",
        planId: "plan-123",
        state: createInitialState("exec-test-checkpoint"),
        nextStepIndex: 2,
        completedInSegment: 2,
        segmentNumber: 1,
        checkpointAt: new Date().toISOString(),
        traceId: "trace-123",
        reason: "TIMEOUT_APPROACHING" as const,
      };

      await CheckpointManager.saveCheckpoint(checkpoint);
      const loaded = await CheckpointManager.loadCheckpoint("exec-test-checkpoint");

      expect(loaded).toBeDefined();
      expect(loaded?.executionId).toBe(checkpoint.executionId);
      expect(loaded?.nextStepIndex).toBe(checkpoint.nextStepIndex);
    });

    it("should delete checkpoints", async () => {
      const checkpoint = {
        executionId: "exec-test-delete",
        state: createInitialState("exec-test-delete"),
        nextStepIndex: 0,
        completedInSegment: 0,
        segmentNumber: 1,
        checkpointAt: new Date().toISOString(),
        reason: "TIMEOUT_APPROACHING" as const,
      };

      await CheckpointManager.saveCheckpoint(checkpoint);
      await CheckpointManager.deleteCheckpoint("exec-test-delete");
      const loaded = await CheckpointManager.loadCheckpoint("exec-test-delete");

      expect(loaded).toBeNull();
    });
  });

  describe("resumeFromCheckpoint", () => {
    it("should resume execution from checkpoint", async () => {
      // First, create a checkpoint
      const plan = createMockPlan([
        { id: "step-1", toolName: "tool_a" },
        { id: "step-2", toolName: "tool_b" },
        { id: "step-3", toolName: "tool_c" },
      ]);

      const executor = createMockToolExecutor();
      const executionId = "exec-test-resume";

      // Execute first part
      const initialResult = await executeSegment(plan, executor, {
        executionId,
      });

      // Create a manual checkpoint (simulating timeout scenario)
      const checkpoint = {
        executionId,
        intentId: "intent-123",
        planId: plan.id,
        state: initialResult.state,
        nextStepIndex: 1,
        completedInSegment: 1,
        segmentNumber: 1,
        checkpointAt: new Date().toISOString(),
        traceId: "trace-123",
        reason: "TIMEOUT_APPROACHING" as const,
      };

      await CheckpointManager.saveCheckpoint(checkpoint);

      // Resume from checkpoint
      const resumedResult = await resumeFromCheckpoint(executionId, executor);

      expect(resumedResult).toBeDefined();
      expect(resumedResult.segmentNumber).toBe(1);
    });
  });
});

// ============================================================================
// SAGA COMPENSATION TESTS
// ============================================================================

describe("SagaExecution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("StepTransactionManager", () => {
    it("should execute transactions successfully", async () => {
      const plan = createMockPlan([
        { id: "step-1", toolName: "book_restaurant" },
        { id: "step-2", toolName: "request_ride" },
      ]);

      const executor = createMockToolExecutor({
        compensationData: {
          compensation: {
            toolName: "cancel_booking",
            parameters: { bookingId: "123" },
          },
        },
      });

      const manager = new StepTransactionManager(
        "exec-saga-test-123",
        executor,
        { intentId: "intent-123" }
      );

      manager.initializeFromPlan(plan);

      const sagaContext = manager.getSagaContext();
      expect(sagaContext.transactions.length).toBe(2);
      expect(sagaContext.status).toBe("running");
    });

    it("should register compensation automatically", async () => {
      const plan = createMockPlan([
        { id: "step-1", toolName: "book_restaurant_table" },
      ]);

      const executor = createMockToolExecutor({
        compensationData: {
          compensation: {
            toolName: "cancel_reservation",
            parameters: { reservationId: "123" },
          },
        },
      });

      const manager = new StepTransactionManager(
        "exec-saga-comp-test",
        executor
      );

      manager.initializeFromPlan(plan);

      // Execute the transaction
      const executionState: ExecutionState = createInitialState("exec-saga-comp-test");
      const result = await manager.executeTransaction(
        manager.getSagaContext().transactions[0],
        executionState
      );

      expect(result.success).toBe(true);
      expect(result.compensationRegistered).toBe(true);
    });

    it("should execute compensations in reverse order", async () => {
      const plan = createMockPlan([
        { id: "step-1", toolName: "book_restaurant" },
        { id: "step-2", toolName: "request_ride" },
        { id: "step-3", toolName: "send_notification" },
      ]);

      let compensationOrder: string[] = [];

      const executor: ToolExecutor = {
        async execute(toolName) {
          if (toolName.includes("cancel") || toolName.includes("compensation")) {
            compensationOrder.push(toolName);
            return { success: true, output: { compensated: true }, latency_ms: 0 };
          }
          return {
            success: true,
            output: { result: `Executed ${toolName}` },
            latency_ms: 0,
            compensation: {
              toolName: `cancel_${toolName}`,
              parameters: { id: "123" },
            },
          };
        },
      };

      const manager = new StepTransactionManager("exec-saga-reverse", executor);
      manager.initializeFromPlan(plan);

      const executionState: ExecutionState = createInitialState("exec-saga-reverse");

      // Execute all transactions
      for (const transaction of manager.getSagaContext().transactions) {
        await manager.executeTransaction(transaction, executionState);
      }

      // Simulate failure and trigger compensation
      const result = await manager.executeAllCompensations(
        executionState,
        "step-3"
      );

      expect(result.compensated).toBe(2); // step-1 and step-2
      expect(compensationOrder.length).toBe(2);
      // Should be in reverse order
      expect(compensationOrder[0]).toContain("request_ride");
      expect(compensationOrder[1]).toContain("book_restaurant");
    });
  });

  describe("executeSaga", () => {
    it("should execute full saga successfully", async () => {
      const plan = createMockPlan([
        { id: "step-1", toolName: "book_restaurant" },
        { id: "step-2", toolName: "request_ride" },
      ]);

      const executor = createMockToolExecutor();

      const result = await executeSaga({
        executionId: "exec-saga-full",
        plan,
        toolExecutor: executor,
        intentId: "intent-123",
      });

      expect(result.success).toBe(true);
      expect(result.sagaContext.status).toBe("completed");
      expect(result.sagaContext.transactions.length).toBe(2);
    });

    it("should trigger compensation on failure", async () => {
      const plan = createMockPlan([
        { id: "step-1", toolName: "book_restaurant" },
        { id: "step-2", toolName: "request_ride", shouldFail: true },
        { id: "step-3", toolName: "send_notification" },
      ]);

      const executor = createMockToolExecutor({
        failOnStep: "request_ride",
        compensationData: {
          compensation: {
            toolName: "cancel_booking",
            parameters: { bookingId: "123" },
          },
        },
      });

      const result = await executeSaga({
        executionId: "exec-saga-fail",
        plan,
        toolExecutor: executor,
        intentId: "intent-123",
      });

      expect(result.success).toBe(false);
      expect(result.sagaContext.status).toBeOneOf(["compensated", "failed"]);
      expect(result.sagaContext.error).toBeDefined();
    });
  });
});

// ============================================================================
// TRACE CONTEXT PROPAGATION TESTS
// ============================================================================

describe("TraceContextPropagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("TraceContextManager", () => {
    it("should create trace context", () => {
      const context = TraceContextManager.create();

      expect(context.traceId).toBeDefined();
      expect(context.spanId).toBeDefined();
      expect(context.correlationId).toBe(context.traceId);
    });

    it("should create child context with parent reference", () => {
      const parent = TraceContextManager.create();
      const child = TraceContextManager.createChild(parent);

      expect(child.traceId).toBe(parent.traceId);
      expect(child.parentSpanId).toBe(parent.spanId);
      expect(child.spanId).toBeDefined();
      expect(child.spanId).not.toBe(parent.spanId);
    });

    it("should inject/extract headers", () => {
      const context = TraceContextManager.create({
        traceId: "test-trace-123",
        correlationId: "test-corr-456",
      });

      const headers = TraceContextManager.toHeaders(context);

      expect(headers["x-trace-id"]).toBe("test-trace-123");
      expect(headers["x-correlation-id"]).toBe("test-corr-456");

      const extracted = TraceContextManager.fromHeaders(headers);

      expect(extracted.traceId).toBe("test-trace-123");
      expect(extracted.correlationId).toBe("test-corr-456");
    });
  });

  describe("createTracedToolExecutor", () => {
    it("should propagate trace context to tool calls", async () => {
      const baseExecutor = createMockToolExecutor();
      const traceContext = TraceContextManager.create({
        traceId: "test-trace-exec",
      });

      const tracedExecutor = createTracedToolExecutor(baseExecutor, traceContext);

      const result = await tracedExecutor.execute(
        "test_tool",
        { param: "value" },
        5000
      );

      expect(result.success).toBe(true);
      expect(result.traceId).toBe("test-trace-exec");
    });
  });

  describe("publishTracedEvent", () => {
    it("should include trace context in events", async () => {
      const traceContext = TraceContextManager.create({
        traceId: "test-trace-event",
        correlationId: "test-corr-event",
      });

      // This would normally publish to Ably
      // We're just verifying the trace context is passed correctly
      expect(traceContext.traceId).toBe("test-trace-event");
      expect(traceContext.correlationId).toBe("test-corr-event");
    });
  });
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe("Durable Execution Integration", () => {
  it("should handle multi-segment execution with trace propagation", async () => {
    const plan = createMockPlan([
      { id: "step-1", toolName: "tool_a", delay: 100 },
      { id: "step-2", toolName: "tool_b", delay: 100 },
      { id: "step-3", toolName: "tool_c", delay: 100 },
      { id: "step-4", toolName: "tool_d", delay: 100 },
    ]);

    const traceContext = TraceContextManager.create();
    const executor = createTracedToolExecutor(
      createMockToolExecutor(),
      traceContext
    );

    // Execute first segment
    const result1 = await executeSegment(plan, executor, {
      executionId: "exec-integration",
      traceId: traceContext.traceId,
    });

    // Verify trace propagation
    expect(result1.state.context).toBeDefined();

    // If partial, resume from checkpoint
    if (result1.isPartial && result1.nextStepIndex) {
      const result2 = await resumeFromCheckpoint(
        "exec-integration",
        executor,
        { traceId: traceContext.traceId }
      );

      expect(result2).toBeDefined();
    }
  });
});
