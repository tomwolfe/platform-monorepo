import { v4 as uuidv4 } from "uuid";
import { AsyncLocalStorage } from "async_hooks";
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
// ASYNC LOCAL STORAGE FOR TRACING CONTEXT
// Propagates correlation IDs through async call chains
// ============================================================================

export const tracingStorage = new AsyncLocalStorage<{
  correlationId: string;
  traceId: string;
  executionId?: string;
}>();

export function getCorrelationId(
  headers?: Headers | Record<string, string | string[] | undefined>,
): string {
  // Check storage first
  const store = tracingStorage.getStore();
  if (store?.correlationId) return store.correlationId;

  if (!headers) return uuidv4();

  if (headers instanceof Headers) {
    return (
      headers.get(CORRELATION_ID_HEADER) ||
      headers.get(TRACE_ID_HEADER) ||
      uuidv4()
    );
  }

  const header = headers[CORRELATION_ID_HEADER] || headers[TRACE_ID_HEADER];
  if (Array.isArray(header)) return header[0] || uuidv4();
  return header || uuidv4();
}

export function getTraceId(
  headers?: Headers | Record<string, string | string[] | undefined>,
): string {
  const store = tracingStorage.getStore();
  if (store?.traceId) return store.traceId;

  if (!headers) return uuidv4();

  if (headers instanceof Headers) {
    return headers.get(TRACE_ID_HEADER) || uuidv4();
  }

  const header = headers[TRACE_ID_HEADER];
  if (Array.isArray(header)) return header[0] || uuidv4();
  return header || uuidv4();
}

export async function withNervousSystemTracing<T>(
  fn: (context: {
    correlationId: string;
    traceId: string;
    executionId?: string;
  }) => Promise<T>,
  existingHeaders?: Headers | Record<string, string | string[] | undefined>,
  executionId?: string,
): Promise<T> {
  const correlationId = getCorrelationId(existingHeaders);
  const traceId = getTraceId(existingHeaders);
  return tracingStorage.run({ correlationId, traceId, executionId }, () =>
    fn({ correlationId, traceId, executionId }),
  );
}

export function injectTracingHeaders(
  headers: Record<string, string> = {},
  correlationId?: string,
  traceId?: string,
  executionId?: string,
): Record<string, string> {
  const store = tracingStorage.getStore();

  headers[CORRELATION_ID_HEADER] =
    correlationId || store?.correlationId || uuidv4();
  headers[TRACE_ID_HEADER] =
    traceId || store?.traceId || headers[CORRELATION_ID_HEADER];

  if (executionId || store?.executionId) {
    headers[EXECUTION_ID_HEADER] = executionId || store!.executionId!;
  }

  return headers;
}

// ============================================================================
// TRACE EMITTER
// Utility for emitting trace entries to Redis or other sinks
// ============================================================================

export interface TraceEmitter {
  emit(entry: ExecutionTraceEntry): Promise<void>;
  flush(traceId: string): Promise<void>;
}

/**
 * In-memory trace emitter (for testing)
 */
export class InMemoryTraceEmitter implements TraceEmitter {
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

/**
 * Redis trace emitter (for production)
 */
export class RedisTraceEmitter implements TraceEmitter {
  private redis: any;
  private buffer = new Map<string, ExecutionTraceEntry[]>();
  private readonly BUFFER_SIZE = 10;
  private readonly TRACE_TTL_SECONDS = 3600; // 1 hour

  constructor(redisClient: any) {
    this.redis = redisClient;
  }

  async emit(entry: ExecutionTraceEntry): Promise<void> {
    const entries = this.buffer.get(entry.trace_id) || [];
    entries.push(entry);
    this.buffer.set(entry.trace_id, entries);

    // Flush when buffer is full
    if (entries.length >= this.BUFFER_SIZE) {
      await this.flush(entry.trace_id);
    }
  }

  async flush(traceId: string): Promise<void> {
    const entries = this.buffer.get(traceId);
    if (!entries || entries.length === 0) return;

    try {
      const key = `trace:${traceId}`;

      // Add entries to Redis stream
      for (const entry of entries) {
        await this.redis.xadd(
          key,
          "*",
          "data",
          JSON.stringify(entry),
          "timestamp",
          entry.timestamp,
        );
      }

      // Set TTL
      await this.redis.expire(key, this.TRACE_TTL_SECONDS);

      this.buffer.delete(traceId);
    } catch (error) {
      console.error("[RedisTraceEmitter] Failed to flush trace:", error);
    }
  }
}

// ============================================================================
// TRACE UTILITIES
// Helper functions for working with traces
// ============================================================================

/**
 * Create a new trace entry
 */
export function createTraceEntry(
  executionId: string,
  eventType: ExecutionTraceEntry["event_type"],
  status: ExecutionTraceEntry["status"],
  options?: Partial<
    Omit<
      ExecutionTraceEntry,
      "trace_id" | "execution_id" | "event_type" | "status" | "timestamp"
    >
  >,
): ExecutionTraceEntry {
  const store = tracingStorage.getStore();

  return {
    trace_id: store?.traceId || uuidv4(),
    execution_id: executionId,
    step_id: options?.step_id,
    app_source: options?.app_source || "shared",
    event_type: eventType,
    status,
    input: options?.input,
    output: options?.output,
    error: options?.error,
    latency_ms: options?.latency_ms,
    timestamp: new Date().toISOString(),
    metadata: options?.metadata,
  };
}

/**
 * Create a step completed trace entry
 */
export function createStepCompletedEntry(
  executionId: string,
  stepId: string,
  output: Record<string, unknown>,
  latencyMs: number,
  appSource: ExecutionTraceEntry["app_source"] = "shared",
): ExecutionTraceEntry {
  return createTraceEntry(executionId, "step_completed", "success", {
    step_id: stepId,
    app_source: appSource,
    output,
    latency_ms: latencyMs,
  });
}

/**
 * Create a step failed trace entry
 */
export function createStepFailedEntry(
  executionId: string,
  stepId: string,
  errorCode: string,
  errorMessage: string,
  appSource: ExecutionTraceEntry["app_source"] = "shared",
): ExecutionTraceEntry {
  return createTraceEntry(executionId, "step_failed", "failure", {
    step_id: stepId,
    app_source: appSource,
    error: {
      code: errorCode,
      message: errorMessage,
    },
  });
}

/**
 * Create an error trace entry
 */
export function createErrorEntry(
  executionId: string,
  errorCode: string,
  errorMessage: string,
  stack?: string,
  appSource: ExecutionTraceEntry["app_source"] = "shared",
): ExecutionTraceEntry {
  return createTraceEntry(executionId, "error", "failure", {
    app_source: appSource,
    error: {
      code: errorCode,
      message: errorMessage,
      stack,
    },
  });
}

// ============================================================================
// GLOBAL TRACE EMITTER
// Shared emitter instance for the application
// ============================================================================

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

/**
 * Emit a trace entry using the global emitter
 */
export async function emitTrace(entry: ExecutionTraceEntry): Promise<void> {
  const emitter = getGlobalTraceEmitter();
  await emitter.emit(entry);
}
