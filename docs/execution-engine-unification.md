# Execution Engine Unification Plan

## Current State Analysis

### Three Competing Sources of Truth

| File | Lines | Purpose | Status |
|------|-------|---------|--------|
| `workflow-machine.ts` | 1604 | Unified workflow engine with saga compensation | **Primary** |
| `durable-execution.ts` | 1061 | Segment-based execution with checkpointing | **Duplicate** |
| `saga-orchestrator.ts` | ~200 | Wrapper delegating to workflow-machine | ✅ Already unified |

### Identified Duplication

**`durable-execution.ts` contains:**
- `CheckpointManager` - Redis persistence logic (duplicates `workflow-machine.ts` checkpoint logic)
- `executeStepWithCheckpointing` - Step execution with timeout monitoring (90% duplicate of `WorkflowMachine.executeStep`)
- `executeSegment` - Segment execution loop (similar to `WorkflowMachine.execute`)
- `resolveStepParameters` - Parameter resolution (duplicate of `WorkflowMachine.resolveStepParameters`)
- `findReadySteps` - Dependency resolution (duplicate of `WorkflowMachine.findReadySteps`)

**`workflow-machine.ts` contains:**
- All of the above, plus:
- `WorkflowMachine` class - Full state machine implementation
- Saga compensation logic
- Yield-and-resume pattern
- Idempotency integration
- Failover policy engine
- Safety policy verification

## Unification Strategy

### Phase 1: Deprecate `durable-execution.ts` (High Priority)

**Action:** Mark all exports as `@deprecated` and redirect to `workflow-machine.ts`

```typescript
// durable-execution.ts - Add deprecation notices
/**
 * @deprecated Use WorkflowMachine from './workflow-machine' instead
 * This module will be removed in v2.0
 */
export async function executeSegment(...) {
  console.warn('[DEPRECATED] executeSegment is deprecated, use WorkflowMachine.execute()');
  // Temporary: delegate to workflow-machine
  const machine = new WorkflowMachine(...);
  return machine.execute();
}
```

**Files to update:**
- Any file importing from `durable-execution.ts` → redirect to `workflow-machine.ts`
- Update tests to use `WorkflowMachine` directly

### Phase 2: Extract Shared Utilities (Medium Priority)

**Create:** `apps/intention-engine/src/lib/engine/utils/execution-utils.ts`

Move duplicated utilities:
- `resolveStepParameters()` - Parameter reference resolution
- `findReadySteps()` - Dependency-based step scheduling
- `executeStepWithCheckpointing()` - Core step execution logic
- `CheckpointManager` → Merge with `WorkflowMachine` checkpoint logic

**Result:** `workflow-machine.ts` uses these utilities internally, reducing its size.

### Phase 3: Create Execution Interface (Medium Priority)

**Create:** `apps/intention-engine/src/lib/engine/types/execution.ts`

```typescript
export interface IWorkflowExecutor {
  execute(): Promise<ExecutionResult>;
  executeSingleStep(stepIndex?: number): Promise<SingleStepResult>;
  getState(): ExecutionState;
  setPlan(plan: Plan): void;
  yieldExecution(reason: string): Promise<WorkflowResult>;
}

// WorkflowMachine implements IWorkflowExecutor
export class WorkflowMachine implements IWorkflowExecutor { ... }
```

**Benefit:** Future execution strategies (e.g., queue-based, event-driven) can implement the same interface.

### Phase 4: Update Tests (High Priority)

**Current test files:**
- `apps/intention-engine/src/lib/__tests__/engine_failure_simulation.test.ts`
- `apps/intention-engine/src/lib/__tests__/workflow-machine.test.ts` (if exists)

**Action:** Ensure all tests use `WorkflowMachine` as the single source of truth.

### Phase 5: Documentation (Low Priority)

**Create:** `apps/intention-engine/src/lib/engine/README.md`

Document:
- Execution flow diagram
- Checkpointing strategy
- Saga compensation pattern
- Yield-and-resume mechanism
- Configuration options

## Migration Checklist

- [ ] Add `@deprecated` JSDoc tags to `durable-execution.ts` exports
- [ ] Update imports in:
  - [ ] `apps/intention-engine/src/app/api/execute/route.ts`
  - [ ] `apps/intention-engine/src/app/api/engine/route.ts`
  - [ ] Test files
- [ ] Create `execution-utils.ts` with shared utilities
- [ ] Refactor `workflow-machine.ts` to use extracted utilities
- [ ] Update tests to use `WorkflowMachine` exclusively
- [ ] Add execution flow documentation
- [ ] Remove `durable-execution.ts` (v2.0)

## Risk Mitigation

**Risk:** Breaking changes in execution behavior
**Mitigation:** 
1. Keep both implementations during transition period (3 sprints)
2. Add integration tests comparing outputs
3. Use feature flag for switching between implementations

**Risk:** Regression in checkpointing behavior
**Mitigation:**
1. Add chaos tests for checkpoint/resume scenarios
2. Monitor `WORKFLOW_RESUME` events in production
3. Add alerts for checkpoint failures

## Success Metrics

- [ ] Zero imports of `durable-execution.ts` in production code
- [ ] `workflow-machine.ts` reduced by 20% (extracted utilities)
- [ ] All execution tests passing
- [ ] No increase in execution failures post-migration
- [ ] Documentation complete

---

**Priority:** High - This reduces cognitive load and prevents bug fixes from being applied inconsistently.

**Estimated Effort:** 3-4 days (including testing and documentation)

**Owner:** Platform Engineering
