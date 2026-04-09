# ADR-002: Transactional Outbox Pattern

**Status:** Accepted
**Date:** 2025-01-10
**Context:** Data Consistency Across Postgres and Redis

## Problem

The platform uses Postgres for business data (reservations, orders) and Redis for saga state caching and real-time pub/sub. Writing to both systems independently creates a split-brain risk: if the Redis write succeeds but Postgres fails (or vice versa), the system enters an inconsistent state where saga orchestration may re-execute completed steps or miss pending ones.

## Decision

Implement the **Transactional Outbox Pattern**:

1. Business data and outbox event records are written in the **same Postgres transaction**
2. A background relay service (`outbox-listener`) polls the outbox table and publishes events to Redis
3. Successfully processed outbox events are marked as `processed`; failed events are retried up to 3 times
4. After 3 failures, events are moved to a **Dead Letter Queue (DLQ)** table for manual inspection
5. Expired DLQ records (>30 days) are cleaned up by a daily cron job

### Implementation Details

- `OutboxService.publish(tx, event)` — called inside the caller's transaction alongside business writes
- `OutboxService.processPendingEvents(limit)` — background worker polls and processes events
- DLQ move is itself wrapped in a transaction: `INSERT outbox_dlq` + `DELETE outbox` are atomic
- Redis confirmation index cleanup (`confirmation:exec:*`) runs via cron to prevent orphaned keys

### Alternatives Considered

1. **Dual-write with compensating transactions** — Complex error recovery; outbox is simpler
2. **CDC (Change Data Capture) with Debezium** — Requires infrastructure (Kafka); overkill for serverless
3. **Redis-only state with Postgres reconciliation** — Risk of state loss during Redis flush/outage

## Consequences

- **Positive:** Guaranteed at-least-once delivery of state change events
- **Positive:** Business data and outbox events are always consistent (same ACID transaction)
- **Negative:** Adds write latency to reservation creation (~5ms for outbox insert)
- **Negative:** Requires background worker for outbox relay (scheduled via QStash cron)

## Related

- ADR-001: MCP Tool Discovery Pattern
- `packages/shared/src/outbox.ts`
- `packages/shared/src/services/outbox-listener.ts`
- `apps/table-stack/src/app/api/cron/cleanup/route.ts`
