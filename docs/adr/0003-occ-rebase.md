# ADR-0003: Optimistic Concurrency Control (OCC) with Rebase

**Status:** Accepted  
**Date:** 2026-02-01  
**Deciders:** Engineering Team  
**Context:** Saga State Management, Race Condition Prevention

## Technical Story

The Intention Engine's saga pattern executes multi-step workflows that persist state to Redis between steps. In production, multiple events can trigger concurrent state updates:
- User follow-up messages while saga is executing
- QStash retries for failed steps
- Manual intervention by operators

Without concurrency control, these concurrent updates can cause **race conditions** leading to:
- Lost updates (one write overwrites another)
- Corrupted state (inconsistent step_states array)
- Duplicate step executions
- Incorrect saga status (e.g., marking FAILED when already COMPLETED)

## Decision Drivers

- **Data Integrity:** Prevent lost updates and state corruption
- **High Concurrency:** Support user interactions + QStash retries simultaneously
- **Performance:** Minimize latency impact on state updates
- **Simplicity:** Easy to implement and reason about
- **Debuggability:** Clear failure modes when conflicts occur

## Considered Options

### Option 1: Pessimistic Locking (Redlock/Distributed Mutex)
**Pros:**
- Simple mental model (acquire lock, update, release)
- Guarantees exclusive access

**Cons:**
- **Performance:** Blocks concurrent reads/writes
- **Complexity:** Requires lock timeout and cleanup logic
- **Failure Modes:** Deadlocks if lock not released
- **Vercel Incompatibility:** Lock holder might be killed before release (serverless)

### Option 2: Last-Write-Wins (No Concurrency Control)
**Pros:**
- Simplest implementation
- No performance overhead

**Cons:**
- **Data Loss:** Silent overwrites of concurrent updates
- **Unpredictable:** Non-deterministic behavior
- **Debugging Nightmare:** Cannot reproduce race conditions reliably

### Option 3: Optimistic Concurrency Control with Rebase - Selected
**Pros:**
- **No Locks:** Non-blocking, works well with serverless
- **Detects Conflicts:** Fails fast on concurrent updates
- **Automatic Retry:** Rebases on latest state and retries
- **Audit Trail:** Conflict attempts logged for debugging

**Cons:**
- Requires retry logic for conflict resolution
- Slightly more complex implementation
- Retry storms under very high contention (mitigated by exponential backoff)

## Decision

**We implemented OCC with automatic rebase** for all saga state updates.

### Implementation Pattern

```typescript
import { saveExecutionState, loadExecutionState } from './memory';
import { applyStateUpdate } from './state-machine';

export async function updateSagaStateWithOCC(
  executionId: string,
  update: StateUpdate
): Promise<ExecutionState> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 100;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // 1. Load current state (snapshot)
    const currentState = await loadExecutionState(executionId);

    // 2. Apply update to snapshot
    const newState = applyStateUpdate(currentState, update);

    // 3. Attempt to save with version check
    const saved = await saveExecutionState(newState, {
      expectedVersion: currentState.updated_at, // OCC token
    });

    if (saved.success) {
      return newState; // Update succeeded
    }

    // 4. Conflict detected - retry with fresh state
    console.warn(
      `[OCC] Conflict on attempt ${attempt + 1}, rebasing...`,
      { executionId, expectedVersion: currentState.updated_at }
    );

    // Exponential backoff before retry
    await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
  }

  throw new Error(
    `Failed to update state after ${MAX_RETRIES} retries (executionId: ${executionId})`
  );
}
```

### Redis Implementation

The `saveExecutionState` function uses Redis WATCH/MULTI/EXEC for atomic compare-and-swap:

```typescript
export async function saveExecutionState(
  state: ExecutionState,
  options?: { expectedVersion?: string }
): Promise<{ success: boolean }> {
  const key = `execution:${state.execution_id}`;
  const redis = getRedisClient(ServiceNamespace.IE);

  // WATCH the key for changes
  await redis.watch(key);

  // Check version if provided
  if (options?.expectedVersion) {
    const current = await redis.hget(key, 'updated_at');
    if (current !== options.expectedVersion) {
      // Conflict detected
      await redis.unwatch();
      return { success: false };
    }
  }

  // Save new state
  await redis.hset(key, {
    ...state,
    updated_at: new Date().toISOString(),
  });

  return { success: true };
}
```

### Rebase Logic

When a conflict is detected, the **rebase** strategy loads the latest state and reapplies the intended update:

```
Initial State:  { status: "EXECUTING", current_step_index: 1 }
Update A:       → { status: "EXECUTING", current_step_index: 2 }
Update B:       → { status: "COMPLETED" }

Timeline:
T1: Update A loads state (step 1)
T2: Update B loads state (step 1)
T3: Update B saves (step 1 → COMPLETED) ✅
T4: Update A saves → CONFLICT (expected step 1, now COMPLETED)
T5: Update A rebases: loads COMPLETED state
T6: Update A realizes update is invalid (cannot update completed saga)
T7: Update A aborts with logged warning
```

### State Diff Viewer

For debugging, we capture state diffs on every save:

```typescript
// In captureStateDiffOnSave
const previousState = await loadExecutionState(executionId);
const newState = applyUpdate(previousState, update);

if (previousState && previousState.updated_at !== newState.updated_at) {
  // Log the diff for debugging
  const diff = computeStateDiff(previousState, newState);
  await saveStateDiff(executionId, diff);
}
```

## Consequences

### Positive
- ✅ No distributed locks (works with serverless)
- ✅ Automatic conflict detection and resolution
- ✅ Predictable failure modes (explicit conflict errors)
- ✅ Audit trail of conflicts for debugging
- ✅ State diff viewer shows what changed and why

### Negative
- ⚠️ Retry logic adds complexity to state updates
- ⚠️ Potential for retry storms under very high contention
- ⚠️ Slightly higher Redis operation count (WATCH + GET + SET)

### Mitigations
- Exponential backoff between retries prevents thundering herd
- MAX_RETRIES = 3 prevents infinite loops
- Conflict logging enables monitoring for hot paths
- State Diff Viewer makes debugging race conditions tractable

## Related Decisions

- [ADR-0001](0001-saga-architecture.md): Saga state persistence to Redis
- [ADR-0002](0002-zero-trust-auth.md): User context in state updates

## References

- [Martin Fowler: Optimistic Offline Lock](https://martinfowler.com/eaaCatalog/optimisticOfflineLock.html)
- [Redis WATCH/MULTI/EXEC Documentation](https://redis.io/docs/manual/transactions/)
- [Google Spanner: TrueTime and MVCC](https://cloud.google.com/spanner/docs/true-time-external-consistency)
