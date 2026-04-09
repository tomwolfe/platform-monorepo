# Saga Orchestration & Checkpointing Flow

## Overview

The `WorkflowMachine` implements the Saga pattern with checkpointing to manage distributed transactions across multiple services. Each step in the workflow is a transaction with a corresponding compensation step. State is persisted to Redis for crash recovery and replay.

## Sequence Diagram: Successful Saga

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant WorkflowMachine as WorkflowMachine
    participant Redis as Redis (Checkpoint Store)
    participant Step1 as Step: Create Reservation
    participant Step2 as Step: Process Payment
    participant Step3 as Step: Notify Driver
    participant Ably as Ably Realtime

    Client->>WorkflowMachine: POST /api/workflows/execute<br/>{steps: [...], compensations: [...]}
    activate WorkflowMachine

    WorkflowMachine->>WorkflowMachine: Generate executionId, traceId
    Note over WorkflowMachine: executionId: wf_abc123<br/>traceId: x-trace-def456

    WorkflowMachine->>Redis: SET wf:state:{executionId}<br/>{status: 'running', currentStep: 0}
    Note over Redis: Checkpoint 0: Initial state

    WorkflowMachine->>Step1: Execute: Create Reservation
    activate Step1
    Step1-->>WorkflowMachine: {status: 'success', data: {reservationId: res_789}}
    deactivate Step1

    WorkflowMachine->>Redis: SET wf:step:{executionId}:0<br/>{status: 'completed', result: {...}}
    WorkflowMachine->>Redis: SET wf:state:{executionId}<br/>{currentStep: 1, status: 'running'}
    Note over Redis: Checkpoint 1: Step 0 complete

    WorkflowMachine->>Step2: Execute: Process Payment
    activate Step2
    Step2-->>WorkflowMachine: {status: 'success', data: {txHash: '0x...'}}
    deactivate Step2

    WorkflowMachine->>Redis: SET wf:step:{executionId}:1<br/>{status: 'completed', result: {...}}
    WorkflowMachine->>Redis: SET wf:state:{executionId}<br/>{currentStep: 2, status: 'running'}
    Note over Redis: Checkpoint 2: Step 1 complete

    WorkflowMachine->>Step3: Execute: Notify Driver
    activate Step3
    Step3->>Ably: Publish to channel: od:orders:{orderId}
    Step3-->>WorkflowMachine: {status: 'success'}
    deactivate Step3

    WorkflowMachine->>Redis: SET wf:step:{executionId}:2<br/>{status: 'completed', result: {...}}
    WorkflowMachine->>Redis: SET wf:state:{executionId}<br/>{currentStep: 3, status: 'completed', completedAt: ...}
    Note over Redis: Checkpoint 3: Saga complete

    WorkflowMachine-->>Client: 200 OK<br/>{executionId, status: 'completed', results: [...]}
    deactivate WorkflowMachine

```

## Sequence Diagram: Saga with Compensation (Failure & Rollback)

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant WorkflowMachine as WorkflowMachine
    participant Redis as Redis (Checkpoint Store)
    participant Step1 as Step: Create Reservation
    participant Step2 as Step: Process Payment
    participant Step3 as Step: Notify Driver
    participant Comp2 as Compensation: Refund Payment
    participant Comp1 as Compensation: Cancel Reservation

    Client->>WorkflowMachine: POST /api/workflows/execute
    activate WorkflowMachine

    WorkflowMachine->>Redis: Checkpoint 0: Initial state
    WorkflowMachine->>Step1: Execute: Create Reservation
    Step1-->>WorkflowMachine: {status: 'success', data: {reservationId: res_789}}
    WorkflowMachine->>Redis: Checkpoint 1: Step 0 complete

    WorkflowMachine->>Step2: Execute: Process Payment
    Step2-->>WorkflowMachine: {status: 'FAILED', error: 'Insufficient funds'}
    Note over WorkflowMachine: Step 2 failed!
    Note over WorkflowMachine: Initiating compensation (rollback)

    WorkflowMachine->>Redis: SET wf:state:{executionId}<br/>{status: 'compensating', failedStep: 1}
    Note over Redis: Mark as compensating

    WorkflowMachine->>Comp1: Compensate: Cancel Reservation<br/>(Reverse of Step 0)
    activate Comp1
    Comp1-->>WorkflowMachine: {status: 'success', data: {cancelled: true}}
    deactivate Comp1

    WorkflowMachine->>Redis: SET wf:compensation:{executionId}:0<br/>{status: 'completed'}
    Note over Redis: Checkpoint: Compensation 0 complete

    WorkflowMachine->>Redis: SET wf:state:{executionId}<br/>{status: 'compensated', compensatedAt: ...}
    Note over Redis: Final state: compensated

    WorkflowMachine-->>Client: 200 OK<br/>{executionId, status: 'compensated',<br/>failedStep: 1, compensation: {...}}
    deactivate WorkflowMachine

```

## State Machine: WorkflowMachine

```mermaid
stateDiagram-v2
    [*] --> Initialized: Workflow created

    Initialized --> Running: Start execution
    Running --> Checkpointing: Step completed
    Checkpointing --> Running: Checkpoint saved

    Running --> Compensating: Step failed
    Compensating --> Compensating: Execute compensation step
    Compensating --> Compensated: All compensations complete
    Compensating --> CompensationFailed: Compensation failed

    Running --> Completed: All steps succeeded
    Completed --> [*]
    Compensated --> [*]

    CompensationFailed --> [*]
    note right of CompensationFailed
      Manual intervention required
      Alert sent to ops team
    end note

    Running --> Failed: Max retries exceeded
    Failed --> [*]

    note right of Checkpointing
      State persisted to Redis
      Crash recovery possible
      TTL: 24 hours
    end note
```

## Redis Persistence Schema

### Key Patterns

| Key Pattern                                 | TTL | Value Schema                                             | Purpose                  |
| ------------------------------------------- | --- | -------------------------------------------------------- | ------------------------ |
| `wf:state:{executionId}`                    | 24h | `{status, currentStep, steps, compensations, startedAt}` | Workflow state machine   |
| `wf:step:{executionId}:{stepIndex}`         | 24h | `{status, result, executedAt, retryCount}`               | Individual step result   |
| `wf:compensation:{executionId}:{compIndex}` | 24h | `{status, result, executedAt}`                           | Compensation step result |
| `wf:trace:{traceId}`                        | 7d  | `{executionId, startedAt, completedAt}`                  | Trace ID correlation     |

### Checkpoint Data Structure

```typescript
interface WorkflowCheckpoint {
  executionId: string;
  traceId: string;
  status: "running" | "completed" | "compensating" | "compensated" | "failed";
  currentStep: number;
  steps: StepResult[];
  compensations: CompensationResult[];
  startedAt: string;
  completedAt?: string;
  failedStep?: number;
  error?: string;
}

interface StepResult {
  index: number;
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  result?: any;
  error?: string;
  executedAt?: string;
  retryCount: number;
}
```

## Crash Recovery Mechanism

When a workflow crashes mid-execution:

```mermaid
sequenceDiagram
    autonumber
    participant Recovery as DLQ Monitor
    participant Redis as Redis (Checkpoint Store)
    participant WorkflowMachine as WorkflowMachine
    participant StepN as Step N (Failed)

    Recovery->>Redis: SCAN wf:state:* MATCH status='running'
    Redis-->>Recovery: [wf:state:wf_abc123, ...]

    Recovery->>Redis: GET wf:state:wf_abc123
    Redis-->>Recovery: {currentStep: 2, status: 'running'}

    Note over Recovery: Check TTL - if > 5 min old, assume crashed

    Recovery->>WorkflowMachine: Resume: wf_abc123
    activate WorkflowMachine

    WorkflowMachine->>Redis: GET wf:step:wf_abc123:0
    Redis-->>WorkflowMachine: {status: 'completed', result: {...}}

    WorkflowMachine->>Redis: GET wf:step:wf_abc123:1
    Redis-->>WorkflowMachine: {status: 'completed', result: {...}}

    Note over WorkflowMachine: Steps 0,1 completed<br/>Resume from step 2

    WorkflowMachine->>StepN: Retry step 2
    StepN-->>WorkflowMachine: {status: 'success', result: {...}}

    WorkflowMachine->>Redis: SET wf:step:wf_abc123:2<br/>{status: 'completed', retryCount: 1}
    WorkflowMachine->>Redis: SET wf:state:wf_abc123<br/>{currentStep: 3, status: 'running'}

    Note over WorkflowMachine: Continue execution...

    deactivate WorkflowMachine
```

## Implementation Details

### Key Files

- **WorkflowMachine**: `packages/shared/src/services/workflow-machine.ts`
- **Checkpoint Store**: `packages/shared/src/services/checkpoint-store.ts`
- **DLQ Monitor**: `packages/shared/src/services/dlq-monitoring.ts`
- **Saga Orchestrator**: `packages/shared/src/services/saga-orchestrator.ts`

### Redis Lua Script for Atomic Checkpointing

```lua
-- packages/shared/src/redis/scripts/checkpoint.lua
-- Atomic checkpoint update with CAS (Compare-And-Swap)

local key = KEYS[1]
local expectedVersion = tonumber(ARGV[1])
newState = cjson.decode(ARGV[2])
local ttl = tonumber(ARGV[3])

local current = redis.call('GET', key)
if current then
    local currentData = cjson.decode(current)
    if currentData.version ~= expectedVersion then
        return {err = 'VERSION_CONFLICT', version = currentData.version}
    end

    newState.version = expectedVersion + 1
    redis.call('SET', key, cjson.encode(newState), 'EX', ttl)
    return {ok = true, version = newState.version}
else
    newState.version = 1
    redis.call('SET', key, cjson.encode(newState), 'EX', ttl)
    return {ok = true, version = 1}
end
```

### Retry with Exponential Backoff

```typescript
// From packages/shared/src/middleware/retry-with-backoff.ts
async function executeStepWithRetry(
  step: Step,
  maxRetries = 3,
): Promise<StepResult> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await step.execute();
      return { status: "completed", result, retryCount: attempt };
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }

      // Exponential backoff with jitter
      const delay = Math.random() * 100 * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
}
```

## Monitoring & Observability

### Metrics

| Metric                 | Description                                | Alert Threshold |
| ---------------------- | ------------------------------------------ | --------------- |
| `saga_duration_ms`     | Total saga execution time                  | p95 > 30s       |
| `step_duration_ms`     | Individual step execution time             | p95 > 5s        |
| `compensation_rate`    | Percentage of sagas requiring compensation | > 5%            |
| `checkpoint_write_ms`  | Redis checkpoint write latency             | p95 > 100ms     |
| `crash_recovery_count` | Number of crashed workflows recovered      | Track trend     |

### Trace ID Propagation

Every workflow generates a unique `x-trace-id` that propagates through all steps:

```typescript
const traceId = `wf-${Date.now()}-${crypto.randomUUID()}`;

// Inject into all downstream API calls
const headers = {
  "x-trace-id": traceId,
  "x-execution-id": executionId,
  "x-step-index": stepIndex.toString(),
};
```

### Log Correlation

All log entries include trace metadata:

```json
{
  "level": "info",
  "message": "Step completed successfully",
  "traceId": "wf-1234567890-abc123",
  "executionId": "wf_abc123",
  "stepIndex": 2,
  "stepName": "ProcessPayment",
  "durationMs": 1234,
  "timestamp": "2026-04-08T10:30:00.000Z"
}
```

## Error Handling

| Error Type            | Scenario                               | Resolution                          |
| --------------------- | -------------------------------------- | ----------------------------------- |
| `STEP_FAILED`         | Step execution fails after max retries | Trigger compensation                |
| `CHECKPOINT_CONFLICT` | Concurrent checkpoint writes           | Retry with CAS rebase               |
| `COMPENSATION_FAILED` | Compensation step fails                | Alert ops, move to DLQ              |
| `CRASH_DETECTED`      | Workflow stuck in 'running' state      | DLQ monitor resumes from checkpoint |
| `TIMEOUT_EXCEEDED`    | Saga exceeds 30s limit                 | Abort and compensate                |

## Testing

```bash
# Run workflow machine unit tests
pnpm test -- workflow-machine

# Run saga integration tests
pnpm test:integration -- saga-orchestrator

# Run crash recovery tests
pnpm test:integration -- crash-recovery

# Run E2E saga flow test
pnpm test:e2e -- saga-flow
```
