import { describe, it, expect } from 'vitest';
import { verifyPlan, SafetyPolicy } from '../engine/verifier';
import { generateIntentHash } from '../engine/intent';
import { Plan } from '../engine/types';
import { randomUUID } from 'crypto';

describe('Plan Verification', () => {
  const mockPlan: Plan = {
    id: randomUUID(),
    intent_id: randomUUID(),
    steps: [
      {
        id: 'step-1',
        step_number: 0,
        tool_name: 'reserve_table',
        parameters: { party_size: 10 },
        dependencies: [],
        description: 'Book a table',
        requires_confirmation: false,
        timeout_ms: 30000,
      },
    ],
    constraints: {
      max_steps: 10,
      max_total_tokens: 1000,
      max_execution_time_ms: 60000,
    },
    metadata: {
      version: '1.0.0',
      created_at: new Date().toISOString(),
      planning_model_id: 'test-model',
      estimated_total_tokens: 100,
      estimated_latency_ms: 1000,
    },
    summary: 'Mock plan',
  };

  const policy: SafetyPolicy = {
    forbiddenSequences: [['search', 'delete_account']],
    parameterLimits: [
      {
        tool: 'reserve_table',
        parameter: 'party_size',
        max: 20,
      },
    ],
  };

  describe('Valid Plan', () => {
    it('should validate a plan with acceptable parameters', () => {
      const result = verifyPlan(mockPlan, policy);
      expect(result.valid).toBe(true);
    });
  });

  describe('Parameter Limit Validation', () => {
    it('should reject a plan when parameter limits are exceeded', () => {
      const invalidPlan: Plan = {
        ...mockPlan,
        steps: [
          {
            ...mockPlan.steps[0],
            parameters: { party_size: 100 },
          },
        ],
      };

      const result = verifyPlan(invalidPlan, policy);
      expect(result.valid).toBe(false);
      expect(result.violation).toBe('PARAMETER_LIMIT_EXCEEDED');
      expect(result.reason).toBeDefined();
    });
  });

  describe('Forbidden Sequence Validation', () => {
    it('should reject a plan with forbidden tool sequences', () => {
      const sequencePlan: Plan = {
        ...mockPlan,
        steps: [
          {
            id: 'step-1',
            step_number: 0,
            tool_name: 'search',
            parameters: { query: 'user' },
            dependencies: [],
            description: 'Search for user',
            requires_confirmation: false,
            timeout_ms: 30000,
          },
          {
            id: 'step-2',
            step_number: 1,
            tool_name: 'delete_account',
            parameters: { id: '123' },
            dependencies: ['step-1'],
            description: 'Delete user',
            requires_confirmation: false,
            timeout_ms: 30000,
          },
        ],
      };

      const result = verifyPlan(sequencePlan, policy);
      expect(result.valid).toBe(false);
      expect(result.violation).toBe('FORBIDDEN_SEQUENCE');
      expect(result.reason).toBeDefined();
    });

    it('should accept a plan with safe tool sequences', () => {
      const safeSequencePlan: Plan = {
        ...mockPlan,
        steps: [
          {
            id: 'step-1',
            step_number: 0,
            tool_name: 'search',
            parameters: { query: 'restaurant' },
            dependencies: [],
            description: 'Search for restaurant',
            requires_confirmation: false,
            timeout_ms: 30000,
          },
          {
            id: 'step-2',
            step_number: 1,
            tool_name: 'reserve_table',
            parameters: { party_size: 4 },
            dependencies: ['step-1'],
            description: 'Book table',
            requires_confirmation: false,
            timeout_ms: 30000,
          },
        ],
      };

      const result = verifyPlan(safeSequencePlan, policy);
      expect(result.valid).toBe(true);
    });
  });

  describe('Intent Hashing', () => {
    it('should generate deterministic hashes for the same intent', () => {
      const hash1 = generateIntentHash('SCHEDULE', { time: '2pm', date: 'today' });
      const hash2 = generateIntentHash('SCHEDULE', { date: 'today', time: '2pm' });
      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different intents', () => {
      const hash1 = generateIntentHash('SCHEDULE', { time: '2pm', date: 'today' });
      const hash3 = generateIntentHash('SCHEDULE', { time: '3pm' });
      expect(hash1).not.toBe(hash3);
    });
  });
});
