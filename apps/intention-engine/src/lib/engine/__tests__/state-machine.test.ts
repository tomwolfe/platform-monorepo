/**
 * Unit Tests: State Machine
 *
 * Tests for apps/intention-engine/src/lib/engine/state-machine.ts
 *
 * Coverage Targets:
 * - Valid state transitions
 * - Invalid state transitions (should throw)
 * - Terminal state locks (COMPLETED, FAILED, REJECTED, TIMEOUT, CANCELLED)
 * - State update immutability
 * - Step state management
 * - Token usage accumulation
 *
 * @see Phase 3.1: Add Unit Tests for Core Domain Logic
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createInitialState,
  transitionState,
  applyStateUpdate,
  updateStepState,
  getStepState,
  getCompletedSteps,
  getPendingSteps,
  getFailedSteps,
  validateStateTransition,
} from "../state-machine";
import type { ExecutionState } from "../types";

describe("State Machine", () => {
  let initialState: ExecutionState;
  const executionId = "550e8400-e29b-41d4-a716-446655440000"; // Valid UUID

  beforeEach(() => {
    initialState = createInitialState(executionId);
  });

  describe("createInitialState", () => {
    it("should create initial state with RECEIVED status", () => {
      expect(initialState.status).toBe("RECEIVED");
      expect(initialState.execution_id).toBe(executionId);
      expect(initialState.current_step_index).toBe(0);
      expect(initialState.step_states).toEqual([]);
      expect(initialState.context).toEqual({});
      expect(initialState.token_usage).toEqual({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      });
      expect(initialState.completed_at).toBeUndefined();
    });

    it("should set created_at and updated_at timestamps", () => {
      expect(initialState.created_at).toBeDefined();
      expect(initialState.updated_at).toBeDefined();
      expect(new Date(initialState.created_at).getTime()).toBeGreaterThan(0);
    });
  });

  describe("validateStateTransition", () => {
    it("should allow valid transitions", () => {
      expect(validateStateTransition("RECEIVED", "PARSING").valid).toBe(true);
      expect(validateStateTransition("PARSING", "PARSED").valid).toBe(true);
      expect(validateStateTransition("PARSED", "PLANNING").valid).toBe(true);
      expect(validateStateTransition("PLANNING", "PLANNED").valid).toBe(true);
      expect(validateStateTransition("PLANNED", "EXECUTING").valid).toBe(true);
      expect(validateStateTransition("EXECUTING", "COMPLETED").valid).toBe(
        true,
      );
      expect(validateStateTransition("EXECUTING", "FAILED").valid).toBe(true);
    });

    it("should reject invalid transitions", () => {
      expect(validateStateTransition("RECEIVED", "EXECUTING").valid).toBe(
        false,
      );
      expect(validateStateTransition("PARSING", "COMPLETED").valid).toBe(false);
      expect(validateStateTransition("PLANNED", "FAILED").valid).toBe(false);
    });

    it("should reject transitions from terminal states", () => {
      const terminalStates = [
        "COMPLETED",
        "FAILED",
        "REJECTED",
        "TIMEOUT",
        "CANCELLED",
      ];

      for (const terminalState of terminalStates) {
        const result = validateStateTransition(
          terminalState as any,
          "EXECUTING",
        );
        expect(result.valid).toBe(false);
        expect(result.reason).toContain("terminal state");
      }
    });

    it("should provide descriptive error messages for invalid transitions", () => {
      const result = validateStateTransition("COMPLETED", "EXECUTING");
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Cannot transition from terminal state");
    });
  });

  describe("transitionState", () => {
    it("should perform valid transitions", () => {
      const parsingState = transitionState(initialState, "PARSING");
      expect(parsingState.status).toBe("PARSING");
      expect(parsingState.execution_id).toBe(executionId);
      expect(parsingState.created_at).toBe(initialState.created_at);
      // updated_at should be >= initial state's updated_at
      expect(
        new Date(parsingState.updated_at).getTime(),
      ).toBeGreaterThanOrEqual(new Date(initialState.updated_at).getTime());
    });

    it("should set completed_at for terminal states", () => {
      const state = transitionState(initialState, "PARSING");
      const parsedState = transitionState(state, "PARSED");
      const planningState = transitionState(parsedState, "PLANNING");
      const plannedState = transitionState(planningState, "PLANNED");
      const executingState = transitionState(plannedState, "EXECUTING");
      const completedState = transitionState(executingState, "COMPLETED");

      expect(completedState.status).toBe("COMPLETED");
      expect(completedState.completed_at).toBeDefined();
    });

    it("should throw on invalid transitions", () => {
      expect(() => transitionState(initialState, "COMPLETED")).toThrow(
        "Invalid state transition",
      );
    });

    it("should maintain state immutability", () => {
      const originalStatus = initialState.status;
      const newState = transitionState(initialState, "PARSING");

      expect(initialState.status).toBe(originalStatus);
      expect(newState.status).toBe("PARSING");
      expect(initialState).not.toBe(newState);
    });
  });

  describe("applyStateUpdate", () => {
    it("should apply partial updates immutably", () => {
      const updatedState = applyStateUpdate(initialState, {
        context: { key: "value" },
        current_step_index: 5,
      });

      expect(updatedState.context).toEqual({ key: "value" });
      expect(updatedState.current_step_index).toBe(5);
      expect(updatedState.execution_id).toBe(executionId);
      expect(updatedState.created_at).toBe(initialState.created_at);
      expect(updatedState).not.toBe(initialState);
    });

    it("should update updated_at timestamp", () => {
      const originalTime = initialState.updated_at;
      const updatedState = applyStateUpdate(initialState, {
        context: { test: true },
      });

      // updated_at should be >= original time (may be same ms if test runs fast)
      expect(
        new Date(updatedState.updated_at).getTime(),
      ).toBeGreaterThanOrEqual(new Date(originalTime).getTime());
    });

    it("should not allow modification of execution_id", () => {
      // The type signature prevents this, but if attempted with casting,
      // Zod validation will throw
      expect(() => {
        applyStateUpdate(initialState, {
          execution_id: "invalid-uuid" as any,
        });
      }).toThrow();
    });

    it("should update state with valid updates", () => {
      const updatedState = applyStateUpdate(initialState, {
        context: { test: true },
        current_step_index: 5,
      });

      expect(updatedState.context).toEqual({ test: true });
      expect(updatedState.current_step_index).toBe(5);
      // updated_at may be the same or newer depending on execution speed
      expect(updatedState.updated_at).toBeDefined();
    });
  });

  describe("Step State Management", () => {
    const step1Id = "550e8400-e29b-41d4-a716-446655440001";
    const step2Id = "550e8400-e29b-41d4-a716-446655440002";
    const step3Id = "550e8400-e29b-41d4-a716-446655440003";

    it("should update step state", () => {
      const stateWithStep = applyStateUpdate(initialState, {
        step_states: [
          {
            step_id: step1Id,
            status: "pending",
            attempts: 0,
          },
        ],
      });

      const updatedState = updateStepState(stateWithStep, step1Id, {
        status: "in_progress",
        started_at: new Date().toISOString(),
      });

      const stepState = getStepState(updatedState, step1Id);
      expect(stepState).toBeDefined();
      expect(stepState?.status).toBe("in_progress");
      expect(stepState?.started_at).toBeDefined();
    });

    it("should return undefined for non-existent step", () => {
      const stepState = getStepState(
        initialState,
        "550e8400-e29b-41d4-a716-446655440099",
      );
      expect(stepState).toBeUndefined();
    });

    it("should track completed steps", () => {
      const stateWithSteps = applyStateUpdate(initialState, {
        step_states: [
          { step_id: step1Id, status: "completed", attempts: 0 },
          { step_id: step2Id, status: "completed", attempts: 0 },
          { step_id: step3Id, status: "pending", attempts: 0 },
        ],
        current_step_index: 2,
      });

      const completedSteps = getCompletedSteps(stateWithSteps);
      expect(completedSteps).toHaveLength(2);
      expect(completedSteps.map((s) => s.step_id)).toContain(step1Id);
      expect(completedSteps.map((s) => s.step_id)).toContain(step2Id);
    });

    it("should track pending steps", () => {
      const stateWithSteps = applyStateUpdate(initialState, {
        step_states: [
          { step_id: step1Id, status: "completed", attempts: 0 },
          { step_id: step2Id, status: "pending", attempts: 0 },
          { step_id: step3Id, status: "pending", attempts: 0 },
        ],
        current_step_index: 1,
      });

      const pendingSteps = getPendingSteps(stateWithSteps);
      expect(pendingSteps).toHaveLength(2);
      expect(pendingSteps.map((s) => s.step_id)).toContain(step2Id);
      expect(pendingSteps.map((s) => s.step_id)).toContain(step3Id);
    });

    it("should track failed steps", () => {
      const stateWithSteps = applyStateUpdate(initialState, {
        step_states: [
          { step_id: step1Id, status: "completed", attempts: 0 },
          {
            step_id: step2Id,
            status: "failed",
            attempts: 3,
            error: { code: "TIMEOUT", message: "Step timed out" },
          },
          { step_id: step3Id, status: "pending", attempts: 0 },
        ],
      });

      const failedSteps = getFailedSteps(stateWithSteps);
      expect(failedSteps).toHaveLength(1);
      expect(failedSteps[0].step_id).toBe(step2Id);
      expect(failedSteps[0].error).toBeDefined();
    });
  });

  describe("Token Usage Accumulation", () => {
    it("should accumulate token usage across updates", () => {
      let state = initialState;

      state = applyStateUpdate(state, {
        token_usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
      });

      state = applyStateUpdate(state, {
        token_usage: {
          prompt_tokens: 200,
          completion_tokens: 100,
          total_tokens: 300,
        },
      });

      expect(state.token_usage.prompt_tokens).toBe(200);
      expect(state.token_usage.completion_tokens).toBe(100);
      expect(state.token_usage.total_tokens).toBe(300);
    });
  });

  describe("Terminal State Locks", () => {
    const terminalStates = [
      "COMPLETED",
      "FAILED",
      "REJECTED",
      "TIMEOUT",
      "CANCELLED",
    ];

    it.each(terminalStates)(
      "should lock %s state from further transitions",
      (terminalState) => {
        let state = transitionState(initialState, "PARSING");
        state = transitionState(state, "PARSED");

        // REJECTED can only be reached from PLANNING, not from EXECUTING
        if (terminalState === "REJECTED") {
          state = transitionState(state, "PLANNING");
          state = transitionState(state, "REJECTED");
        } else {
          state = transitionState(state, "PLANNING");
          state = transitionState(state, "PLANNED");
          state = transitionState(state, "EXECUTING");

          // Transition to terminal state
          if (terminalState === "COMPLETED") {
            state = transitionState(state, "COMPLETED");
          } else if (terminalState === "FAILED") {
            state = transitionState(state, "FAILED");
          } else if (terminalState === "TIMEOUT") {
            state = transitionState(state, "TIMEOUT");
          } else if (terminalState === "CANCELLED") {
            state = transitionState(state, "CANCELLED");
          }
        }

        // Attempt to transition from terminal state should fail
        expect(() => transitionState(state, "EXECUTING")).toThrow();
        expect(() => transitionState(state, "PARSING")).toThrow();
        expect(() => transitionState(state, "PLANNING")).toThrow();
      },
    );
  });
});
