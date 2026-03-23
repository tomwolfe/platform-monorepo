
import { describe, it, expect } from 'vitest';
import { normalizeIntent } from '../normalization';

describe('Deep Semantic Parameter Validation', () => {
  const modelId = 'test-model';

  describe('Temporal Expression Validation', () => {
    it('should penalize confidence for past dates in SCHEDULE intents', () => {
      const pastDate = new Date();
      pastDate.setFullYear(pastDate.getFullYear() - 1);

      const candidatePast = {
        type: 'SCHEDULE' as const,
        confidence: 0.95,
        parameters: {
          action: 'SCHEDULE',
          temporal_expression: pastDate.toISOString(),
          topic: 'Past meeting',
        },
        explanation: 'Scheduling a meeting in the past.',
      };

      const normalizedPast = normalizeIntent(candidatePast, 'Schedule a meeting for last year', modelId);

      expect(normalizedPast.confidence).toBeLessThan(0.85);
      expect(normalizedPast.explanation?.toLowerCase()).toContain('past');
    });

    it('should accept relative time expressions in SCHEDULE intents with high confidence', () => {
      const candidateRelative = {
        type: 'SCHEDULE' as const,
        confidence: 0.95,
        parameters: {
          action: 'SCHEDULE',
          temporal_expression: 'tomorrow at 5pm',
          topic: 'Relative meeting',
        },
        explanation: 'Scheduling a meeting using a relative time expression.',
      };

      const normalizedRelative = normalizeIntent(
        candidateRelative,
        'Schedule a meeting for tomorrow at 5pm',
        modelId
      );

      expect(normalizedRelative.confidence).toBe(0.95);
    });

    it('should accept future dates in SCHEDULE intents with high confidence', () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const candidateFuture = {
        type: 'SCHEDULE' as const,
        confidence: 0.95,
        parameters: {
          action: 'SCHEDULE',
          temporal_expression: futureDate.toISOString(),
          topic: 'Future meeting',
        },
        explanation: 'Scheduling a meeting in the future.',
      };

      const normalizedFuture = normalizeIntent(candidateFuture, 'Schedule a meeting for next year', modelId);

      expect(normalizedFuture.confidence).toBe(0.95);
      expect(normalizedFuture.type).toBe('SCHEDULE');
    });
  });
});
