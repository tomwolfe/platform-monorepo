import { z } from "zod";

// ============================================================================
// TRACING HEADERS
// Standard headers for distributed tracing across apps
// ============================================================================

export const CORRELATION_ID_HEADER = "x-correlation-id";
export const TRACE_ID_HEADER = "x-trace-id";
export const IDEMPOTENCY_KEY_HEADER = "x-idempotency-key";
export const EXECUTION_ID_HEADER = "x-execution-id";

// ============================================================================
// EXECUTION TRACE CONTRACT
// Unified tracing schema for cross-app execution tracking
// ============================================================================

/**
 * Execution Trace Entry
 * Tracks a single step in the cross-app execution flow
 */
export const ExecutionTraceEntrySchema = z.object({
  // Identifiers
  trace_id: z.string().uuid(),
  execution_id: z.string().uuid(),
  step_id: z.string().uuid().optional(),

  // App source - which app emitted this trace
  app_source: z.enum([
    "intention-engine",
    "table-stack",
    "open-delivery",
    "shared",
  ]),

  // Event details
  event_type: z.enum([
    "intent_received",
    "intent_parsed",
    "planning_started",
    "plan_generated",
    "plan_validated",
    "execution_started",
    "step_started",
    "step_completed",
    "step_failed",
    "execution_completed",
    "execution_failed",
    "fallback_triggered",
    "compensation_executed",
    "error",
  ]),

  // Status
  status: z.enum(["success", "failure", "pending"]),

  // Input/output for observability (optional, can be large)
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.record(z.string(), z.unknown()).optional(),

  // Error details
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      stack: z.string().optional(),
    })
    .optional(),

  // Performance
  latency_ms: z.number().int().nonnegative().optional(),
  timestamp: z.string().datetime(),

  // Context for debugging
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ExecutionTraceEntry = z.infer<typeof ExecutionTraceEntrySchema>;

/**
 * Execution Trace
 * Complete trace of a cross-app execution
 */
export const ExecutionTraceSchema = z.object({
  trace_id: z.string().uuid(),
  execution_id: z.string().uuid(),
  intent_id: z.string().uuid(),
  variant: z.enum([
    "BOOKING_ONLY",
    "BOOKING_FALLBACK_TO_DELIVERY",
    "UNIFIED_DINING_WITH_DELIVERY",
    "DELIVERY_ONLY",
  ]),
  entries: z.array(ExecutionTraceEntrySchema),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().optional(),
  status: z.enum(["in_progress", "completed", "failed", "degraded"]),
  total_latency_ms: z.number().int().nonnegative().optional(),
});

export type ExecutionTrace = z.infer<typeof ExecutionTraceSchema>;

// ============================================================================
// BROWSER-SAFE TRACING UTILITIES
// These functions work without AsyncLocalStorage (Node.js only)
// ============================================================================

export function getCorrelationId(
  headers?: Headers | Record<string, string | string[] | undefined>,
): string {
  if (!headers) return crypto.randomUUID();

  if (headers instanceof Headers) {
    return (
      headers.get(CORRELATION_ID_HEADER) ||
      headers.get(TRACE_ID_HEADER) ||
      crypto.randomUUID()
    );
  }

  const header = headers[CORRELATION_ID_HEADER] || headers[TRACE_ID_HEADER];
  if (Array.isArray(header)) return header[0] || crypto.randomUUID();
  return header || crypto.randomUUID();
}

export function getTraceId(
  headers?: Headers | Record<string, string | string[] | undefined>,
): string {
  if (!headers) return crypto.randomUUID();

  if (headers instanceof Headers) {
    return headers.get(TRACE_ID_HEADER) || crypto.randomUUID();
  }

  const header = headers[TRACE_ID_HEADER];
  if (Array.isArray(header)) return header[0] || crypto.randomUUID();
  return header || crypto.randomUUID();
}

export function injectTracingHeaders(
  headers: Record<string, string> = {},
  correlationId?: string,
  traceId?: string,
  executionId?: string,
): Record<string, string> {
  headers[CORRELATION_ID_HEADER] = correlationId || crypto.randomUUID();
  headers[TRACE_ID_HEADER] = traceId || headers[CORRELATION_ID_HEADER];

  if (executionId) {
    headers[EXECUTION_ID_HEADER] = executionId;
  }

  return headers;
}

/**
 * In-memory trace emitter (for testing and client-side use)
 */
export class InMemoryTraceEmitter {
  private traces = new Map<string, ExecutionTraceEntry[]>();

  async emit(entry: ExecutionTraceEntry): Promise<void> {
    const entries = this.traces.get(entry.trace_id) || [];
    entries.push(entry);
    this.traces.set(entry.trace_id, entries);
    console.log(
      `[Trace] ${entry.event_type} - ${entry.status} (${entry.latency_ms}ms)`,
    );
  }

  async flush(traceId: string): Promise<void> {
    this.traces.delete(traceId);
  }

  getEntries(traceId: string): ExecutionTraceEntry[] {
    return this.traces.get(traceId) || [];
  }
}

export type TraceEmitter = {
  emit(entry: ExecutionTraceEntry): Promise<void>;
  flush(traceId: string): Promise<void>;
};

// Global emitter for client-side use
let globalTraceEmitter: TraceEmitter | null = null;

export function setGlobalTraceEmitter(emitter: TraceEmitter): void {
  globalTraceEmitter = emitter;
}

export function getGlobalTraceEmitter(): TraceEmitter {
  if (!globalTraceEmitter) {
    globalTraceEmitter = new InMemoryTraceEmitter();
  }
  return globalTraceEmitter;
}

export async function emitTrace(entry: ExecutionTraceEntry): Promise<void> {
  const emitter = getGlobalTraceEmitter();
  await emitter.emit(entry);
}
