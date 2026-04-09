# ADR-001: MCP Tool Discovery Pattern

**Status:** Accepted
**Date:** 2025-01-15
**Context:** Intention Engine → Table-Stack Integration

## Problem

The intention engine (LLM-based planner) needs to discover and invoke table-stack capabilities (reservation, availability, waitlist, etc.) without hardcoding every tool schema and endpoint. As the platform grows, new services will add their own tools, and the system must scale without requiring central registry updates.

## Decision

Adopt the **Model Context Protocol (MCP)** for tool discovery and invocation:

- Each service (table-stack, open-delivery) exposes an `/api/mcp` endpoint with a standardized tool registry
- The intention engine discovers tools at startup via MCP `initialize` + `tools/list`
- Tool schemas are defined in `@repo/mcp-protocol/src/schemas/` as shared Zod schemas
- Tools are namespaced by service (e.g., `tableStack.getAvailability`, `openDelivery.calculateQuote`)

### Alternatives Considered

1. **Hardcoded tool registry in intention engine** — Simple but doesn't scale; every new service requires engine changes
2. **OpenAPI spec parsing** — Overly broad; MCP provides semantic tool descriptions with typed parameters
3. **gRPC service discovery** — Overkill for serverless; MCP over HTTP is simpler for Vercel deployments

## Consequences

- **Positive:** Services are independently deployable; new tools auto-discovered without engine redeployment
- **Positive:** Tool schemas are validated with Zod on both provider and consumer sides
- **Negative:** Adds MCP protocol dependency; cold start includes tool discovery phase
- **Mitigation:** Tool discovery results are cached in Redis with 1-hour TTL

## Related

- ADR-002: Transactional Outbox Pattern
- `packages/mcp-protocol/src/schemas/`
- `apps/table-stack/src/app/api/mcp/route.ts`
- `apps/intention-engine/src/lib/engine/planner/`
