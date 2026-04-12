/**
 * Trace Context Propagation
 *
 * Ensures x-trace-id (Correlation ID) is propagated through:
 * 1. Every tool call
 * 2. Ably events
 * 3. MCP client requests
 * 4. Inter-service communication
 *
 * This maintains a single audit trail across all services.
 */

import { randomUUID } from "crypto";
import {
  RealtimeService,
  Logger,
  tracingStorage,
  TRACE_ID_HEADER,
} from "@repo/shared";
import { Tracer } from "./tracing";
import type { Span } from "@opentelemetry/api";

const logger = new Logger({ serviceName: "intention-engine" });

// ============================================================================
// TRACE CONTEXT
// ============================================================================

export interface TraceContext {
  /** Unique trace ID for the entire request flow */
  traceId: string;
  /** Span ID for the current operation */
  spanId?: string;
  /** Parent span ID (for nested operations) */
  parentSpanId?: string;
  /** Correlation ID for linking related operations */
  correlationId?: string;
  /** Additional baggage/context data */
  baggage?: Record<string, string>;
}

// ============================================================================
// TRACE CONTEXT MANAGER
// ============================================================================

export class TraceContextManager {
  /**
   * Create a new trace context
   */
  static create(options?: Partial<TraceContext>): TraceContext {
    const traceId = options?.traceId || randomUUID();
    const correlationId = options?.correlationId || traceId;

    const context: TraceContext = {
      traceId,
      spanId: randomUUID(),
      correlationId,
      baggage: options?.baggage || {},
    };

    return context;
  }

  /**
   * Create a child context from a parent
   */
  static createChild(parent: TraceContext): TraceContext {
    const context: TraceContext = {
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      spanId: randomUUID(),
      correlationId: parent.correlationId,
      baggage: { ...parent.baggage },
    };

    return context;
  }

  /**
   * Store context in AsyncLocalStorage for the current execution scope.
   * This replaces the LRU cache pattern with native async context propagation.
   */
  static store(context: TraceContext): void {
    if (!tracingStorage) {
      return;
    }
    const store = tracingStorage.getStore();
    if (store) {
      // Update existing store with new trace context
      Object.assign(store, {
        traceId: context.traceId,
        correlationId: context.correlationId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        baggage: context.baggage,
      });
    }
  }

  /**
   * Retrieve stored context from AsyncLocalStorage
   */
  static retrieve(): TraceContext | undefined {
    if (!tracingStorage) {
      return undefined;
    }
    const store = tracingStorage.getStore();
    if (!store) {
      return undefined;
    }
    return {
      traceId: store.traceId,
      correlationId: store.correlationId,
    };
  }

  /**
   * Clear stored context (no-op with AsyncLocalStorage - context is scoped automatically)
   */
  static clear(): void {
    // With AsyncLocalStorage, context is automatically cleared when the async scope ends
    // No manual cleanup needed
  }

  /**
   * Extract trace context from headers
   */
  static fromHeaders(headers: Headers | Record<string, string>): TraceContext {
    const getHeader = (name: string): string | undefined => {
      if (headers instanceof Headers) {
        return headers.get(name) || undefined;
      }
      return headers[name];
    };

    const traceId = getHeader("x-trace-id") || randomUUID();
    const correlationId = getHeader("x-correlation-id") || traceId;
    const parentSpanId = getHeader("x-parent-span-id") || undefined;

    return {
      traceId,
      correlationId,
      parentSpanId,
      spanId: randomUUID(),
    };
  }

  /**
   * Inject trace context into headers
   */
  static toHeaders(
    context: TraceContext,
    existingHeaders?: Headers | Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = {};

    // Copy existing headers
    if (existingHeaders) {
      if (existingHeaders instanceof Headers) {
        existingHeaders.forEach((value, key) => {
          headers[key] = value;
        });
      } else {
        Object.assign(headers, existingHeaders);
      }
    }

    // Inject trace headers
    headers["x-trace-id"] = context.traceId;
    headers["x-correlation-id"] = context.correlationId || context.traceId;

    if (context.spanId) {
      headers["x-span-id"] = context.spanId;
    }

    if (context.parentSpanId) {
      headers["x-parent-span-id"] = context.parentSpanId;
    }

    return headers;
  }
}

// ============================================================================
// TRACE PROPAGATION UTILITIES
// ============================================================================

/**
 * Generate a new trace ID
 */
export function generateTraceId(): string {
  return randomUUID();
}

/**
 * Extract trace ID from request headers
 */
export function extractTraceId(
  headers: Headers | Record<string, string>,
): string {
  const context = TraceContextManager.fromHeaders(headers);
  return context.traceId;
}

/**
 * Create trace headers for outgoing requests
 */
export function createTraceHeaders(
  traceId: string,
  correlationId?: string,
): Record<string, string> {
  return {
    "x-trace-id": traceId,
    "x-correlation-id": correlationId || traceId,
  };
}

// ============================================================================
// WRAPPED TOOL EXECUTOR WITH TRACE PROPAGATION
// ============================================================================

import { ToolExecutor } from "./workflow-machine";

export interface TracedToolExecutor {
  execute(
    toolName: string,
    parameters: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
    traceContext?: TraceContext,
  ): Promise<{
    success: boolean;
    output?: unknown;
    error?: string;
    latency_ms: number;
    traceId?: string;
  }>;
}

/**
 * Create a tool executor wrapper that propagates trace context
 */
export function createTracedToolExecutor(
  baseExecutor: ToolExecutor,
  defaultTraceContext?: TraceContext,
): TracedToolExecutor {
  return {
    async execute(toolName, parameters, timeoutMs, signal, traceContext) {
      const context =
        traceContext || defaultTraceContext || TraceContextManager.create();

      return Tracer.startActiveSpan(`tool:${toolName}`, async (span) => {
        // Set trace attributes
        span.setAttributes({
          "trace.id": context.traceId,
          "trace.correlation_id": context.correlationId,
          "tool.name": toolName,
          "tool.timeout_ms": timeoutMs,
        });

        try {
          const result = await baseExecutor.execute(
            toolName,
            parameters,
            timeoutMs,
            signal,
          );

          // Record result attributes
          span.setAttributes({
            "tool.success": result.success,
            "tool.latency_ms": result.latency_ms,
          });

          if (!result.success) {
            span.recordException(
              new Error(result.error || "Tool execution failed"),
            );
          }

          return {
            ...result,
            traceId: context.traceId,
          };
        } catch (error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          span.recordException(err);
          throw error;
        }
      });
    },
  };
}

// ============================================================================
// ABLY EVENT PUBLISHER WITH TRACE PROPAGATION
// ============================================================================

export interface TraceableEventPayload {
  [key: string]: unknown;
  traceId?: string;
  correlationId?: string;
}

/**
 * Publish event to Ably with trace context propagation
 */
export async function publishTracedEvent(
  channelName: string,
  eventName: string,
  data: TraceableEventPayload,
  traceContext: TraceContext,
): Promise<void> {
  // Inject trace context into data
  const tracedData = {
    ...data,
    traceId: traceContext.traceId,
    correlationId: traceContext.correlationId,
  };

  // Publish with trace context
  await RealtimeService.publish(channelName, eventName, tracedData, {
    traceId: traceContext.traceId,
    correlationId: traceContext.correlationId,
  });

  logger.info(
    `[TracePropagation] Published ${eventName} to ${channelName} [trace: ${traceContext.traceId}]`,
  );
}

/**
 * Publish to Nervous System with trace context
 */
export async function publishTracedNervousSystemEvent(
  eventName: string,
  data: TraceableEventPayload,
  traceContext: TraceContext,
): Promise<void> {
  await publishTracedEvent(
    "nervous-system:updates",
    eventName,
    data,
    traceContext,
  );
}

// ============================================================================
// MIDDLEWARE FOR TRACE CONTEXT EXTRACTION
// ============================================================================

/**
 * Express/Next.js middleware to extract trace context from requests.
 * Stores context in AsyncLocalStorage for automatic propagation.
 */
export function extractTraceFromRequest(
  headers: Headers | Record<string, string>,
): TraceContext {
  const context = TraceContextManager.fromHeaders(headers);

  // Store context in AsyncLocalStorage
  TraceContextManager.store(context);

  return context;
}

/**
 * Get current trace context from AsyncLocalStorage
 */
export function getCurrentTraceContext(): TraceContext | undefined {
  return TraceContextManager.retrieve();
}

// ============================================================================
// TRACE CONTEXT SERIALIZATION
// ============================================================================

/**
 * Serialize trace context for logging
 */
export function serializeTraceContext(context: TraceContext): string {
  return `[trace:${context.traceId}${context.correlationId ? ` | corr:${context.correlationId}` : ""}]`;
}

/**
 * Create a logger wrapper that includes trace context
 */
export function createTracedLogger(baseLogger: Console, context: TraceContext) {
  const prefix = serializeTraceContext(context);

  return {
    log: (...args: unknown[]) => baseLogger.log(prefix, ...args),
    warn: (...args: unknown[]) => baseLogger.warn(prefix, ...args),
    error: (...args: unknown[]) => baseLogger.error(prefix, ...args),
    info: (...args: unknown[]) => baseLogger.info(prefix, ...args),
    debug: (...args: unknown[]) => baseLogger.debug(prefix, ...args),
  };
}
