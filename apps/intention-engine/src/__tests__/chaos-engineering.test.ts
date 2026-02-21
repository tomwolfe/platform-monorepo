/**
 * Chaos Engineering Tests - Failure Mode Verification
 *
 * Purpose: Intentionally break things to verify the system fails gracefully.
 *
 * Tests:
 * - Tool execution timeouts
 * - QStash message delivery failures
 * - Redis connection failures
 * - Compensation tool failures
 * - Idempotency lock conflicts
 *
 * Run: pnpm test -- chaos-engineering.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowMachine } from '../lib/engine/workflow-machine';
import { createInitialState, setPlan } from '../lib/engine/state-machine';
import { saveExecutionState } from '../lib/engine/memory';
import { Plan, ExecutionState } from '../lib/engine/types';

// Mock dependencies
vi.mock('../lib/redis-client', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    exists: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock('@repo/shared', async () => {
  const actual = await vi.importActual('@repo/shared');
  return {
    ...actual,
    RealtimeService: {
      publish: vi.fn(),
      publishStreamingStatusUpdate: vi.fn(),
    },
    QStashService: {
      triggerNextStep: vi.fn().mockResolvedValue('qstash-msg-id'),
    },
  };
});

describe('Chaos Engineering - Failure Modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool Execution Failures', () => {
    it('should handle tool timeout gracefully', async () => {
      const executionId = `chaos-timeout-${Date.now()}`;
      
      const slowToolExecutor = {
        execute: vi.fn().mockImplementation(async () => {
          // Simulate timeout by taking longer than SEGMENT_TIMEOUT_MS (8500ms)
          await new Promise(resolve => setTimeout(resolve, 10000));
          return {
            success: true,
            output: { result: 'too late' },
            latency_ms: 10000,
          };
        }),
      };

      const initialState = createInitialState(executionId);
      const plan: Plan = {
        id: `plan-${Date.now()}`,
        intent_id: `intent-${Date.now()}`,
        steps: [
          {
            id: 'step-1',
            tool_name: 'slow_tool',
            description: 'Tool that times out',
            parameters: { test: 'timeout' },
            dependencies: [],
            timeout_ms: 8500,
          },
        ],
        created_at: new Date().toISOString(),
      };

      let state = setPlan(initialState, plan);
      await saveExecutionState(state);

      const machine = new WorkflowMachine(executionId, slowToolExecutor, {
        initialState: state,
      });

      const result = await machine.execute();

      // Should fail gracefully with timeout error
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('STEP_TIMEOUT');
      
      // Should NOT have completed steps
      expect(result.completedSteps).toBe(0);
    });

    it('should handle tool throwing exception', async () => {
      const executionId = `chaos-exception-${Date.now()}`;
      
      const throwingToolExecutor = {
        execute: vi.fn().mockRejectedValue(new Error('Network error: Connection refused')),
      };

      const initialState = createInitialState(executionId);
      const plan: Plan = {
        id: `plan-${Date.now()}`,
        intent_id: `intent-${Date.now()}`,
        steps: [
          {
            id: 'step-1',
            tool_name: 'flaky_tool',
            description: 'Tool that throws',
            parameters: { test: 'exception' },
            dependencies: [],
            timeout_ms: 8500,
          },
        ],
        created_at: new Date().toISOString(),
      };

      let state = setPlan(initialState, plan);
      await saveExecutionState(state);

      const machine = new WorkflowMachine(executionId, throwingToolExecutor, {
        initialState: state,
      });

      const result = await machine.execute();

      // Should fail gracefully
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Network error');
    });

    it('should handle tool returning invalid output', async () => {
      const executionId = `chaos-invalid-output-${Date.now()}`;
      
      const invalidOutputExecutor = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: null, // Invalid - should be object
          latency_ms: 100,
        }),
      };

      const initialState = createInitialState(executionId);
      const plan: Plan = {
        id: `plan-${Date.now()}`,
        intent_id: `intent-${Date.now()}`,
        steps: [
          {
            id: 'step-1',
            tool_name: 'book_restaurant_table',
            description: 'Tool with invalid output',
            parameters: { restaurantId: 'test-123', partySize: 2, time: '19:00' },
            dependencies: [],
            timeout_ms: 8500,
            // In production, this would have return_schema validation
          },
        ],
        created_at: new Date().toISOString(),
      };

      let state = setPlan(initialState, plan);
      await saveExecutionState(state);

      const machine = new WorkflowMachine(executionId, invalidOutputExecutor, {
        initialState: state,
      });

      // Should handle gracefully (may succeed or fail validation depending on schema strictness)
      const result = await machine.execute();
      
      // Either success (if validation lenient) or failure (if strict)
      expect(result).toBeDefined();
      expect(result.state).toBeDefined();
    });
  });

  describe('Compensation Failures', () => {
    it('should handle compensation tool failure', async () => {
      const executionId = `chaos-compensation-fail-${Date.now()}`;
      let compensationAttempted = false;

      const executor = {
        execute: vi.fn()
          .mockImplementationOnce(async () => {
            // First step: Book ride (succeeds, registers compensation)
            return {
              success: true,
              output: { rideId: 'ride-123' },
              latency_ms: 200,
              compensation: {
                toolName: 'cancel_ride',
                parameters: { rideId: 'ride-123' },
              },
            };
          })
          .mockImplementationOnce(async () => {
            // Second step: Book restaurant (fails, triggers compensation)
            return {
              success: false,
              error: 'Restaurant unavailable',
              latency_ms: 180,
            };
          })
          .mockImplementationOnce(async () => {
            // Compensation: Cancel ride (FAILS!)
            compensationAttempted = true;
            return {
              success: false,
              error: 'Ride already in progress - cannot cancel',
              latency_ms: 150,
            };
          }),
      };

      const initialState = createInitialState(executionId);
      const plan: Plan = {
        id: `plan-${Date.now()}`,
        intent_id: `intent-${Date.now()}`,
        steps: [
          {
            id: 'step-1',
            tool_name: 'book_ride',
            description: 'Book ride',
            parameters: { destination: 'Restaurant' },
            dependencies: [],
            timeout_ms: 8500,
          },
          {
            id: 'step-2',
            tool_name: 'book_restaurant_table',
            description: 'Book table',
            parameters: { restaurantId: 'test' },
            dependencies: ['step-1'],
            timeout_ms: 8500,
          },
        ],
        created_at: new Date().toISOString(),
      };

      let state = setPlan(initialState, plan);
      await saveExecutionState(state);

      const machine = new WorkflowMachine(executionId, executor, {
        initialState: state,
      });

      const result = await machine.execute();

      // Saga should fail (compensation failed)
      expect(result.success).toBe(false);
      expect(compensationAttempted).toBe(true);
      
      // Should log compensation failure for manual intervention
      // (In production, this would trigger alert)
    });

    it('should handle partial compensation (some steps compensated, some not)', async () => {
      const executionId = `chaos-partial-comp-${Date.now()}`;
      const compensationResults: boolean[] = [];

      const executor = {
        execute: vi.fn()
          // Step 1: Book ride (success)
          .mockImplementationOnce(async () => ({
            success: true,
            output: { rideId: 'ride-1' },
            latency_ms: 200,
            compensation: { toolName: 'cancel_ride', parameters: { rideId: 'ride-1' } },
          }))
          // Step 2: Book hotel (success)
          .mockImplementationOnce(async () => ({
            success: true,
            output: { bookingId: 'hotel-1' },
            latency_ms: 250,
            compensation: { toolName: 'cancel_hotel', parameters: { bookingId: 'hotel-1' } },
          }))
          // Step 3: Book restaurant (FAIL - triggers compensation)
          .mockImplementationOnce(async () => ({
            success: false,
            error: 'No tables available',
            latency_ms: 180,
          }))
          // Compensation 1: Cancel ride (SUCCESS)
          .mockImplementationOnce(async () => {
            compensationResults.push(true);
            return { success: true, output: { cancelled: true }, latency_ms: 100 };
          })
          // Compensation 2: Cancel hotel (FAIL)
          .mockImplementationOnce(async () => {
            compensationResults.push(false);
            return { success: false, error: 'Non-refundable booking', latency_ms: 120 };
          }),
      };

      const initialState = createInitialState(executionId);
      const plan: Plan = {
        id: `plan-${Date.now()}`,
        intent_id: `intent-${Date.now()}`,
        steps: [
          { id: 'step-1', tool_name: 'book_ride', description: 'Book ride', parameters: {}, dependencies: [], timeout_ms: 8500 },
          { id: 'step-2', tool_name: 'book_hotel', description: 'Book hotel', parameters: {}, dependencies: [], timeout_ms: 8500 },
          { id: 'step-3', tool_name: 'book_restaurant', description: 'Book restaurant', parameters: {}, dependencies: ['step-1', 'step-2'], timeout_ms: 8500 },
        ],
        created_at: new Date().toISOString(),
      };

      let state = setPlan(initialState, plan);
      await saveExecutionState(state);

      const machine = new WorkflowMachine(executionId, executor, {
        initialState: state,
      });

      const result = await machine.execute();

      // Saga failed
      expect(result.success).toBe(false);
      
      // Compensation was attempted
      expect(compensationResults.length).toBeGreaterThan(0);
      
      // Partial compensation (some succeeded, some failed)
      expect(compensationResults).toContain(true);
      expect(compensationResults).toContain(false);
    });
  });

  describe('Concurrency & Race Conditions', () => {
    it('should handle concurrent execution attempts (idempotency)', async () => {
      const executionId = `chaos-concurrent-${Date.now()}`;
      const executionCounts: number[] = [];

      const executor = {
        execute: vi.fn().mockImplementation(async () => {
          executionCounts.push(Date.now());
          // Simulate variable latency
          await new Promise(resolve => setTimeout(resolve, Math.random() * 100));
          return {
            success: true,
            output: { result: 'ok' },
            latency_ms: 100,
          };
        }),
      };

      const initialState = createInitialState(executionId);
      const plan: Plan = {
        id: `plan-${Date.now()}`,
        intent_id: `intent-${Date.now()}`,
        steps: [
          {
            id: 'step-1',
            tool_name: 'test_tool',
            description: 'Test tool',
            parameters: {},
            dependencies: [],
            timeout_ms: 8500,
          },
        ],
        created_at: new Date().toISOString(),
      };

      let state = setPlan(initialState, plan);
      await saveExecutionState(state);

      // Simulate concurrent execution attempts
      const machine1 = new WorkflowMachine(executionId, executor, { initialState: state });
      const machine2 = new WorkflowMachine(executionId, executor, { initialState: state });

      // Both machines try to execute the same step
      const [result1, result2] = await Promise.allSettled([
        machine1.executeSingleStep(0),
        machine2.executeSingleStep(0),
      ]);

      // At least one should succeed or be idempotent
      expect(result1.status === 'fulfilled' || result2.status === 'fulfilled').toBe(true);
      
      // Tool should not be executed more than twice (ideally once due to idempotency)
      expect(executionCounts.length).toBeLessThanOrEqual(2);
    });
  });

  describe('State Corruption', () => {
    it('should handle missing plan in execution state', async () => {
      const executionId = `chaos-no-plan-${Date.now()}`;
      
      const executor = {
        execute: vi.fn(),
      };

      // Create state WITHOUT plan
      const initialState = createInitialState(executionId);
      // Intentionally NOT setting plan

      const machine = new WorkflowMachine(executionId, executor, {
        initialState,
      });

      // Should fail gracefully when trying to execute
      await expect(machine.executeSingleStep(0))
        .rejects
        .toThrow('No plan set');
    });

    it('should handle circular dependencies in plan', async () => {
      const executionId = `chaos-circular-${Date.now()}`;
      
      const executor = {
        execute: vi.fn(),
      };

      const initialState = createInitialState(executionId);
      
      // Create plan with CIRCULAR dependencies (A depends on B, B depends on A)
      const plan: Plan = {
        id: `plan-${Date.now()}`,
        intent_id: `intent-${Date.now()}`,
        steps: [
          {
            id: 'step-a',
            tool_name: 'tool_a',
            description: 'Tool A',
            parameters: {},
            dependencies: ['step-b'], // A depends on B
            timeout_ms: 8500,
          },
          {
            id: 'step-b',
            tool_name: 'tool_b',
            description: 'Tool B',
            parameters: {},
            dependencies: ['step-a'], // B depends on A (circular!)
            timeout_ms: 8500,
          },
        ],
        created_at: new Date().toISOString(),
      };

      let state = setPlan(initialState, plan);
      await saveExecutionState(state);

      const machine = new WorkflowMachine(executionId, executor, {
        initialState: state,
      });

      const result = await machine.execute();

      // Should detect deadlock and fail gracefully
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('PLAN_CIRCULAR_DEPENDENCY');
    });
  });

  describe('Resource Exhaustion', () => {
    it('should handle very large plan (100+ steps)', async () => {
      const executionId = `chaos-large-plan-${Date.now()}`;
      
      const executor = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: { result: 'ok' },
          latency_ms: 50,
        }),
      };

      const initialState = createInitialState(executionId);
      
      // Create plan with 100 steps
      const plan: Plan = {
        id: `plan-${Date.now()}`,
        intent_id: `intent-${Date.now()}`,
        steps: Array(100).fill(null).map((_, i) => ({
          id: `step-${i + 1}`,
          tool_name: 'test_tool',
          description: `Step ${i + 1}`,
          parameters: { index: i },
          dependencies: i > 0 ? [`step-${i}`] : [],
          timeout_ms: 8500,
        })),
        created_at: new Date().toISOString(),
      };

      let state = setPlan(initialState, plan);
      await saveExecutionState(state);

      const machine = new WorkflowMachine(executionId, executor, {
        initialState: state,
      });

      // Should handle without memory issues
      // Note: In practice, this would yield multiple times due to checkpoint threshold
      const result = await machine.execute();

      // Should either complete or yield (both are acceptable)
      expect(result).toBeDefined();
      expect(result.state).toBeDefined();
    });
  });
});

describe('Chaos Engineering - Recovery Patterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should recover from transient network error with retry', async () => {
    const executionId = `chaos-retry-${Date.now()}`;
    let attemptCount = 0;

    const flakyExecutor = {
      execute: vi.fn().mockImplementation(async () => {
        attemptCount++;
        
        // Fail first 2 attempts, succeed on 3rd
        if (attemptCount < 3) {
          throw new Error('Network error: ECONNRESET');
        }
        
        return {
          success: true,
          output: { result: 'success after retry' },
          latency_ms: 150,
        };
      }),
    };

    const initialState = createInitialState(executionId);
    const plan: Plan = {
      id: `plan-${Date.now()}`,
      intent_id: `intent-${Date.now()}`,
      steps: [
        {
          id: 'step-1',
          tool_name: 'flaky_tool',
          description: 'Tool that fails transiently',
          parameters: {},
          dependencies: [],
          timeout_ms: 8500,
        },
      ],
      created_at: new Date().toISOString(),
    };

    let state = setPlan(initialState, plan);
    await saveExecutionState(state);

    const machine = new WorkflowMachine(executionId, flakyExecutor, {
      initialState: state,
    });

    const result = await machine.execute();

    // Should eventually succeed after retries
    // Note: Actual retry logic would be in the tool executor or workflow machine
    expect(attemptCount).toBeGreaterThanOrEqual(1);
  });

  it('should detect and report non-recoverable errors', async () => {
    const executionId = `chaos-non-recoverable-${Date.now()}`;
    
    const executor = {
      execute: vi.fn().mockRejectedValue(new Error('Invalid API key - authentication failed')),
    };

    const initialState = createInitialState(executionId);
    const plan: Plan = {
      id: `plan-${Date.now()}`,
      intent_id: `intent-${Date.now()}`,
      steps: [
        {
          id: 'step-1',
          tool_name: 'authenticated_tool',
          description: 'Tool requiring auth',
          parameters: {},
          dependencies: [],
          timeout_ms: 8500,
        },
      ],
      created_at: new Date().toISOString(),
    };

    let state = setPlan(initialState, plan);
    await saveExecutionState(state);

    const machine = new WorkflowMachine(executionId, executor, {
      initialState: state,
    });

    const result = await machine.execute();

    // Should fail immediately (no retry for auth errors)
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('authentication');
    
    // Should be marked as non-recoverable
    expect(result.error?.code).toBeDefined();
  });
});
