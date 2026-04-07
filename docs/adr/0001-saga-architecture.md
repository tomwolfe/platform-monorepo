# ADR-0001: Saga Architecture with QStash

**Status:** Accepted  
**Date:** 2026-01-15  
**Deciders:** Engineering Team  
**Context:** Intention Engine Orchestrator

## Technical Story

The Intention Engine needs to execute multi-step workflows (e.g., search tables → reserve table → send confirmation) that can exceed Vercel's 10-second serverless timeout. We needed a durable execution pattern that works within serverless constraints without requiring complex infrastructure.

## Decision Drivers

- **Vercel Hobby Tier Constraints:** 10s hard timeout, no long-running processes
- **Reliability Requirements:** Multi-step workflows must complete even if individual steps fail
- **Operational Complexity:** Avoid managing message queue infrastructure
- **Cost Efficiency:** Pay-per-use model aligned with serverless architecture
- **Developer Experience:** Simple API for defining and executing sagas

## Considered Options

### Option 1: BullMQ + Redis Lists
**Pros:**
- Full control over queue behavior
- Rich feature set (priority queues, rate limiting)
- Well-tested and mature

**Cons:**
- Requires persistent Redis instance (additional cost/complexity)
- No built-in retry with exponential backoff
- Worker processes must run continuously (incompatible with serverless)
- Manual dead-letter queue implementation needed

### Option 2: Custom Redis State Machine + fetch(self)
**Pros:**
- No external dependencies
- Full customization
- Works with existing Redis infrastructure

**Cons:**
- `fetch(self)` unreliable in serverless (cold starts, timeout risks)
- Manual retry logic required
- No guarantee of delivery
- Complex error handling and monitoring

### Option 3: QStash (Selected)
**Pros:**
- Serverless-native: HTTP-based, no persistent connections
- Built-in retries with exponential backoff
- Dead-letter queue out of the box
- Scheduled execution support
- Pay-per-use pricing (aligns with serverless model)
- Reliable delivery guarantees
- Simple HTTP API

**Cons:**
- External dependency (Upstash service)
- Less fine-grained control than self-hosted solutions
- Vendor lock-in risk (mitigated by abstraction layer)

## Decision

**We chose QStash** for durable saga execution due to its serverless-native architecture and built-in reliability features.

### Implementation Pattern

```typescript
// After each step completes:
await QStashService.triggerNextStep({
  executionId: 'exec_123',
  stepIndex: 1,
  url: '/api/engine/execute-step',
});

// The execute-step endpoint loads state from Redis and continues:
const state = await loadExecutionState(executionId);
const nextStep = state.step_states[state.current_step_index];
await executeToolCall(nextStep);
```

### Key Architectural Components

1. **WorkflowMachine** (`apps/intention-engine/src/lib/engine/workflow-machine.ts`):
   - Manages saga state with yield-and-resume pattern
   - Checkpoints state to Redis at 6s (before 10s timeout)
   - Registers compensations for rollback on failure

2. **QStashService** (`packages/shared/src/services/qstash.ts`):
   - Abstracts QStash API calls
   - Provides retry logic and fallback behavior
   - Supports immediate, delayed, and scheduled execution

3. **State Persistence** (`apps/intention-engine/src/lib/engine/memory.ts`):
   - Redis-backed execution state storage
   - Supports OCC (Optimistic Concurrency Control) for race condition prevention

## Consequences

### Positive
- ✅ Reliable multi-step execution beyond 10s timeout
- ✅ Automatic retry with exponential backoff
- ✅ Dead-letter queue for failed sagas (manual intervention possible)
- ✅ Cost-efficient (pay per invocation, not per hour)
- ✅ Simple developer experience

### Negative
- ⚠️ External dependency on Upstash QStash service
- ⚠️ Async execution makes debugging more complex (mitigated by comprehensive tracing)
- ⚠️ Network latency for QStash HTTP calls (~50-100ms per step)

### Mitigations
- QStashService abstraction allows swapping providers if needed
- Comprehensive audit logging and trace entries for debugging
- State Diff Viewer for comparing saga states across steps
- Circuit breaker pattern prevents cascade failures

## Related Decisions

- [ADR-0003](0003-occ-rebase.md): Optimistic Concurrency Control for saga state
- [ADR-0002](0002-zero-trust-auth.md): Authentication for QStash webhook endpoints
