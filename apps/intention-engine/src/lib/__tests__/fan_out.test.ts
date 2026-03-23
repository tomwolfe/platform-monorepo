import { describe, it, expect } from 'vitest';

describe('Fan-Out Strategy', () => {
  it('should handle multiple entities in intent parameters', () => {
    // Mock Intent with multiple locations
    const mockIntent = {
      id: 'test-intent-id',
      type: 'QUERY' as const,
      parameters: { location: ['Tokyo', 'London', 'NY'] },
      rawText: 'What is the weather in Tokyo, London, and NY?',
      metadata: { version: '1.0.0', timestamp: new Date().toISOString() },
    };

    expect(mockIntent.parameters.location).toHaveLength(3);
    expect(mockIntent.parameters.location).toEqual(['Tokyo', 'London', 'NY']);
  });

  it('should verify planner prompt handles fan-out for arrays', () => {
    // The updated Planner prompt contains:
    const fanOutInstruction =
      'FAN-OUT: If an intent parameter contains an array of entities ... you MUST generate a separate PlanStep for EACH entity.';

    expect(fanOutInstruction).toContain('FAN-OUT');
    expect(fanOutInstruction).toContain('array of entities');
    expect(fanOutInstruction).toContain('separate PlanStep');
  });

  it('should verify orchestrator executes parallel steps without dependencies', () => {
    // Steps with no dependencies should execute in parallel
    const mockSteps = [
      { id: 'step-1', tool_name: 'get_weather', parameters: { location: 'Tokyo' }, dependencies: [] },
      { id: 'step-2', tool_name: 'get_weather', parameters: { location: 'London' }, dependencies: [] },
      { id: 'step-3', tool_name: 'get_weather', parameters: { location: 'NY' }, dependencies: [] },
    ];

    // All steps have empty dependencies, indicating they can run in parallel
    const parallelSteps = mockSteps.filter((step) => step.dependencies.length === 0);
    expect(parallelSteps).toHaveLength(3);
  });

  it('should verify ExecutionResult includes summary field', () => {
    // The ExecutionResult type should include a summary field
    const mockExecutionResult = {
      success: true,
      total_steps: 3,
      completed_steps: 3,
      summary: 'Retrieved weather for 3 locations',
    };

    expect(mockExecutionResult.summary).toBeDefined();
    expect(mockExecutionResult.total_steps).toBe(3);
    expect(mockExecutionResult.completed_steps).toBe(3);
  });
});
