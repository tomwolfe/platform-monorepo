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
import { RealtimeService } from "@repo/shared";
import { Tracer } from "./tracing";
import { Span } from "@opentelemetry/api";

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
  public static storage = new Map<string, TraceContext>();

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
   * Store context for later retrieval
   */
  static store(contextId: string, context: TraceContext): void {
    this.storage.set(contextId, context);
  }

  /**
   * Retrieve stored context
   */
  static retrieve(contextId: string): TraceContext | undefined {
    return this.storage.get(contextId);
  }

  /**
   * Clear stored context
   */
  static clear(contextId: string): void {
    this.storage.delete(contextId);
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
    existingHeaders?: Headers | Record<string, string>
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
  headers: Headers | Record<string, string>
): string {
  const context = TraceContextManager.fromHeaders(headers);
  return context.traceId;
}

/**
 * Create trace headers for outgoing requests
 */
export function createTraceHeaders(
  traceId: string,
  correlationId?: string
): Record<string, string> {
  return {
    "x-trace-id": traceId,
    "x-correlation-id": correlationId || traceId,
  };
}

// ============================================================================
// WRAPPED TOOL EXECUTOR WITH TRACE PROPAGATION
// ============================================================================

import { ToolExecutor } from "./durable-execution";

export interface TracedToolExecutor {
  execute(
    toolName: string,
    parameters: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
    traceContext?: TraceContext
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
  defaultTraceContext?: TraceContext
): TracedToolExecutor {
  return {
    async execute(toolName, parameters, timeoutMs, signal, traceContext) {
      const context = traceContext || defaultTraceContext || TraceContextManager.create();
      
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
            signal
          );

          // Record result attributes
          span.setAttributes({
            "tool.success": result.success,
            "tool.latency_ms": result.latency_ms,
          });

          if (!result.success) {
            span.recordException(new Error(result.error || "Tool execution failed"));
          }

          return {
            ...result,
            traceId: context.traceId,
          };
        } catch (error: any) {
          span.recordException(error);
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
  traceContext: TraceContext
): Promise<void> {
  // Inject trace context into data
  const tracedData = {
    ...data,
    traceId: traceContext.traceId,
    correlationId: traceContext.correlationId,
  };

  // Publish with trace context
  await RealtimeService.publish(
    channelName,
    eventName,
    tracedData,
    {
      traceId: traceContext.traceId,
      correlationId: traceContext.correlationId,
    }
  );

  console.log(
    `[TracePropagation] Published ${eventName} to ${channelName} ` +
    `[trace: ${traceContext.traceId}]`
  );
}

/**
 * Publish to Nervous System with trace context
 */
export async function publishTracedNervousSystemEvent(
  eventName: string,
  data: TraceableEventPayload,
  traceContext: TraceContext
): Promise<void> {
  await publishTracedEvent(
    "nervous-system:updates",
    eventName,
    data,
    traceContext
  );
}

// ============================================================================
// MIDDLEWARE FOR TRACE CONTEXT EXTRACTION
// ============================================================================

/**
 * Express/Next.js middleware to extract trace context from requests
 */
export function extractTraceFromRequest(
  headers: Headers | Record<string, string>
): TraceContext {
  const context = TraceContextManager.fromHeaders(headers);
  
  // Store context for later retrieval
  const contextId = `req:${context.traceId}`;
  TraceContextManager.store(contextId, context);
  
  return context;
}

/**
 * Get current trace context from storage
 */
export function getCurrentTraceContext(contextId?: string): TraceContext | undefined {
  if (!contextId) {
    // Return most recent context
    const entries = Array.from(TraceContextManager.storage.entries());
    if (entries.length > 0) {
      return entries[entries.length - 1][1];
    }
    return undefined;
  }
  
  return TraceContextManager.retrieve(contextId);
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
export function createTracedLogger(
  baseLogger: Console,
  context: TraceContext
) {
  const prefix = serializeTraceContext(context);
  
  return {
    log: (...args: any[]) => baseLogger.log(prefix, ...args),
    warn: (...args: any[]) => baseLogger.warn(prefix, ...args),
    error: (...args: any[]) => baseLogger.error(prefix, ...args),
    info: (...args: any[]) => baseLogger.info(prefix, ...args),
    debug: (...args: any[]) => baseLogger.debug(prefix, ...args),
  };
}
