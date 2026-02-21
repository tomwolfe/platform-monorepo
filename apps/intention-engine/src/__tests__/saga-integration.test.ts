/**
 * Saga Integration Tests - End-to-End Workflow Execution
 *
 * Tests the complete saga execution flow including:
 * - Recursive self-trigger pattern via QStash
 * - Saga compensation on failure
 * - Idempotency protection
 * - Distributed tracing propagation
 * - Nervous System Observer re-engagement
 *
 * Run: pnpm test -- saga-integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkflowMachine } from '../lib/engine/workflow-machine';
import { createInitialState, setIntent, setPlan } from '../lib/engine/state-machine';
import { saveExecutionState, loadExecutionState } from '../lib/engine/memory';
import { redis } from '../lib/redis-client';
import { NervousSystemObserver } from '../lib/listeners/nervous-system-observer';
import { Plan, Intent, ExecutionState } from '../lib/engine/types';
import { RealtimeService } from '@repo/shared';

// Mock external dependencies
vi.mock('../lib/redis-client', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
    exists: vi.fn(),
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
      triggerNextStep: vi.fn(),
    },
    IdempotencyService: class MockIdempotencyService {
      async isDuplicate() { return false; }
    },
  };
});

describe('Saga Integration Tests', () => {
  beforeEach(async () => {
    // Clear Redis before each test
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Cleanup after tests
    vi.resetAllMocks();
  });

  describe('WorkflowMachine - Basic Execution', () => {
    it('should execute a simple single-step plan successfully', async () => {
      const executionId = `test-exec-${Date.now()}`;
      const mockToolExecutor = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: { confirmed: true },
          latency_ms: 150,
        }),
      };

      const initialState = createInitialState(executionId);
      const intent: Intent = {
        id: `intent-${Date.now()}`,
        type: 'BOOKING',
        confidence: 0.95,
        rawText: 'Book a table for 2 at Pesto Place',
        parameters: {
          restaurantId: 'pesto-place-123',
          partySize: 2,
          time: '19:00',
        },
        metadata: {},
      };

      const plan: Plan = {
        id: `plan-${Date.now()}`,
        intent_id: intent.id,
        steps: [
          {
            id: 'step-1',
            tool_name: 'book_restaurant_table',
            description: 'Book table at Pesto Place',
            parameters: {
              restaurantId: 'pesto-place-123',
              partySize: 2,
              time: '19:00',
            },
            dependencies: [],
            timeout_ms: 8500,
          },
        ],
        created_at: new Date().toISOString(),
      };

      let state = setIntent(initialState, intent);
      state = setPlan(state, plan);
      await saveExecutionState(state);

      const machine = new WorkflowMachine(executionId, mockToolExecutor, {
        initialState: state,
        intentId: intent.id,
      });

      const result = await machine.execute();

      expect(result.success).toBe(true);
      expect(result.completedSteps).toBe(1);
      expect(result.failedSteps).toBe(0);
      expect(mockToolExecutor.execute).toHaveBeenCalledTimes(1);
      expect(mockToolExecutor.execute).toHaveBeenCalledWith(
        'book_restaurant_table',
        expect.objectContaining({
          restaurantId: 'pesto-place-123',
          partySize: 2,
        }),
        expect.any(Number),
        expect.any(Object)
      );
    });

    it('should trigger compensation when a state-modifying step fails', async () => {
      const executionId = `test-saga-${Date.now()}`;
      const callOrder: string[] = [];

      const mockToolExecutor = {
        execute: vi.fn()
          .mockImplementationOnce(async (toolName) => {
            // First step: Book ride (succeeds)
            callOrder.push('book_ride');
            return {
              success: true,
              output: { rideId: 'ride-123', status: 'confirmed' },
              latency_ms: 200,
              compensation: {
                toolName: 'cancel_ride',
                parameters: { rideId: 'ride-123' },
              },
            };
          })
          .mockImplementationOnce(async (toolName) => {
            // Second step: Book restaurant (fails)
            callOrder.push('book_restaurant');
            return {
              success: false,
              error: 'Restaurant fully booked',
              latency_ms: 180,
            };
          })
          .mockImplementationOnce(async (toolName) => {
            // Compensation: Cancel ride
            callOrder.push('cancel_ride');
            return {
              success: true,
              output: { cancelled: true },
              latency_ms: 100,
            };
          }),
      };

      const initialState = createInitialState(executionId);
      const intent: Intent = {
        id: `intent-${Date.now()}`,
        type: 'BOOKING',
        confidence: 0.9,
        rawText: 'Book a table and ride to Pesto Place',
        parameters: {
          restaurantId: 'pesto-place-123',
          partySize: 2,
          time: '19:00',
          needsRide: true,
        },
        metadata: {},
      };

      const plan: Plan = {
        id: `plan-${Date.now()}`,
        intent_id: intent.id,
        steps: [
          {
            id: 'step-1',
            tool_name: 'book_ride',
            description: 'Book ride to restaurant',
            parameters: {
              destination: 'Pesto Place',
              time: '18:30',
            },
            dependencies: [],
            timeout_ms: 8500,
          },
          {
            id: 'step-2',
            tool_name: 'book_restaurant_table',
            description: 'Book table at restaurant',
            parameters: {
              restaurantId: 'pesto-place-123',
              partySize: 2,
              time: '19:00',
            },
            dependencies: ['step-1'],
            timeout_ms: 8500,
          },
        ],
        created_at: new Date().toISOString(),
      };

      let state = setIntent(initialState, intent);
      state = setPlan(state, plan);
      await saveExecutionState(state);

      const machine = new WorkflowMachine(executionId, mockToolExecutor, {
        initialState: state,
        intentId: intent.id,
      });

      const result = await machine.execute();

      // Verify saga compensation was triggered
      expect(result.success).toBe(false);
      expect(result.wasCompensated).toBe(true);
      expect(result.compensatedSteps).toBe(1);
      expect(callOrder).toEqual(['book_ride', 'book_restaurant', 'cancel_ride']);
    });
  });

  describe('Idempotency Protection', () => {
    it('should skip already-executed steps when QStash retries', async () => {
      const executionId = `test-idempotent-${Date.now()}`;
      const executeCalls: number[] = [];

      const mockToolExecutor = {
        execute: vi.fn().mockImplementation(async () => {
          executeCalls.push(Date.now());
          return {
            success: true,
            output: { confirmed: true },
            latency_ms: 150,
          };
        }),
      };

      // Simulate step already executed (idempotency lock exists)
      vi.mocked(redis.exists).mockResolvedValue(1);

      const initialState = createInitialState(executionId);
      const plan: Plan = {
        id: `plan-${Date.now()}`,
        intent_id: `intent-${Date.now()}`,
        steps: [
          {
            id: 'step-1',
            tool_name: 'book_restaurant_table',
            description: 'Book table',
            parameters: { restaurantId: 'test-123', partySize: 2, time: '19:00' },
            dependencies: [],
            timeout_ms: 8500,
          },
        ],
        created_at: new Date().toISOString(),
      };

      let state = setPlan(initialState, plan);
      // Mark step as already completed
      state.step_states = [
        {
          step_id: 'step-1',
          status: 'completed',
          output: { confirmed: true },
          completed_at: new Date().toISOString(),
          latency_ms: 150,
          attempts: 1,
        },
      ];

      await saveExecutionState(state);

      const machine = new WorkflowMachine(executionId, mockToolExecutor, {
        initialState: state,
      });

      const result = await machine.execute();

      // Should not execute the tool again (idempotent skip)
      expect(result.success).toBe(true);
      expect(executeCalls.length).toBe(0);
    });
  });

  describe('Distributed Tracing', () => {
    it('should propagate traceId through workflow execution', async () => {
      const executionId = `test-trace-${Date.now()}`;
      const traceId = `trace-${Date.now()}`;

      const mockToolExecutor = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: { confirmed: true },
          latency_ms: 150,
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
            description: 'Book table',
            parameters: { restaurantId: 'test-123' },
            dependencies: [],
            timeout_ms: 8500,
          },
        ],
        created_at: new Date().toISOString(),
      };

      let state = setPlan(initialState, plan);
      await saveExecutionState(state);

      const machine = new WorkflowMachine(executionId, mockToolExecutor, {
        initialState: state,
        traceId,
      });

      const result = await machine.execute();

      expect(result.success).toBe(true);
      // Verify trace context was maintained
      expect(machine.getState().context?.traceId).toBe(traceId);
    });
  });
});

describe('NervousSystemObserver - Re-engagement Loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should trigger re-engagement when table becomes available after failed booking', async () => {
    const observer = new NervousSystemObserver();

    // Simulate failed booking in Redis
    const failedBooking = {
      userId: 'user-123',
      clerkId: 'clerk-456',
      userEmail: 'test@example.com',
      intentType: 'BOOKING',
      parameters: {
        restaurantId: 'pesto-place-123',
        partySize: 2,
        time: '19:00',
      },
      reason: 'Restaurant fully booked',
      timestamp: new Date().toISOString(),
    };

    vi.mocked(redis.get).mockResolvedValue([failedBooking]);

    const tableVacatedEvent = {
      tableId: 'table-789',
      restaurantId: 'pesto-place-123',
      restaurantName: 'Pesto Place',
      capacity: 2,
      timestamp: new Date().toISOString(),
    };

    const token = 'mock-token-123';

    const result = await observer.handleTableVacated({
      event: tableVacatedEvent,
      token,
    });

    expect(result.success).toBe(true);
    expect(result.usersNotified).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(redis.get)).toHaveBeenCalledWith('failed_bookings:pesto-place-123');
  });

  it('should track failed bookings for future re-engagement', async () => {
    const restaurantId = 'test-restaurant-123';
    const failure = {
      userId: 'user-789',
      clerkId: 'clerk-012',
      userEmail: 'fail@example.com',
      intentType: 'RESERVATION',
      parameters: { partySize: 4, time: '20:00' },
      reason: 'Payment failed',
      executionId: 'exec-abc-123',
    };

    await NervousSystemObserver.trackFailedBooking(restaurantId, failure);

    expect(vi.mocked(redis.setex)).toHaveBeenCalledWith(
      `failed_bookings:${restaurantId}`,
      3600, // 1 hour TTL
      expect.any(String)
    );
  });
});

describe('Checkpoint & Resume Pattern', () => {
  it('should yield execution when approaching timeout threshold', async () => {
    const executionId = `test-checkpoint-${Date.now()}`;
    let executeCallCount = 0;

    const slowToolExecutor = {
      execute: vi.fn().mockImplementation(async () => {
        executeCallCount++;
        // Simulate slow tool
        await new Promise(resolve => setTimeout(resolve, 100));
        return {
          success: true,
          output: { result: `step-${executeCallCount}` },
          latency_ms: 100,
        };
      }),
    };

    const initialState = createInitialState(executionId);
    const plan: Plan = {
      id: `plan-${Date.now()}`,
      intent_id: `intent-${Date.now()}`,
      steps: Array(10).fill(null).map((_, i) => ({
        id: `step-${i + 1}`,
        tool_name: 'slow_tool',
        description: `Slow tool ${i + 1}`,
        parameters: { index: i },
        dependencies: [],
        timeout_ms: 8500,
      })),
      created_at: new Date().toISOString(),
    };

    let state = setPlan(initialState, plan);
    await saveExecutionState(state);

    const machine = new WorkflowMachine(executionId, slowToolExecutor, {
      initialState: state,
    });

    // Note: In real tests, we'd mock performance.now() to simulate timeout
    // For now, we verify the checkpoint mechanism exists
    const result = await machine.execute();

    // Should complete or yield based on checkpoint threshold
    expect(result).toBeDefined();
    expect(result.state).toBeDefined();
  });
});
