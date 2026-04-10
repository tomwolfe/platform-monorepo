/**
 * Trace Context Propagator
 *
 * Ensures trace IDs are propagated across async boundaries:
 * - QStash message publishing
 * - Ably event publishing
 * - Redis lock operations
 * - Any async message passing
 *
 * This module provides utilities to attach and extract trace IDs
 * from payloads, ensuring end-to-end traceability in Grafana Tempo.
 *
 * Usage:
 * ```typescript
 * // Publishing a message
 * const payload = attachTraceToPayload({ data: '...' });
 * await qstash.publish({ body: JSON.stringify(payload) });
 *
 * // Consuming a message
 * const traceId = extractTraceFromPayload(message);
 * tracingStorage.run({ traceId, ... }, () => processMessage(message));
 * ```
 *
 * @see Task 7: Guarantee End-to-End Trace ID Propagation
 */

import { tracingStorage, TRACE_ID_HEADER } from "../tracing";

// ============================================================================
// TRACE METADATA KEY
// Standardized key for trace metadata in payloads
// ============================================================================

export const TRACE_META_KEY = "__meta";
export const TRACE_ID_META_KEY = "traceId";

// ============================================================================
// PAYLOAD ATTACHMENT
// ============================================================================

/**
 * Attach the current trace ID to a payload for async message passing.
 *
 * This should be called before publishing messages to:
 * - QStash queues
 * - Ably channels
 * - Redis streams
 * - Any other async boundary
 *
 * @param payload - The message payload to attach trace ID to
 * @returns Payload with trace ID metadata added
 *
 * @example
 * ```typescript
 * // Before publishing to QStash
 * const message = attachTraceToPayload({
 *   executionId: "abc-123",
 *   action: "notify_owner",
 * });
 * await qstash.publishJSON({ body: message });
 * ```
 */
export function attachTraceToPayload<T extends Record<string, unknown>>(
  payload: T,
): T & { [TRACE_META_KEY]?: { [TRACE_ID_META_KEY]?: string } } {
  // Try to get trace from AsyncLocalStorage first
  const store = tracingStorage.getStore();
  const traceId = store?.traceId;

  if (!traceId) {
    // No active trace - return payload unchanged
    return payload as T & {
      [TRACE_META_KEY]?: { [TRACE_ID_META_KEY]?: string };
    };
  }

  return {
    ...payload,
    [TRACE_META_KEY]: {
      ...((payload[TRACE_META_KEY] as Record<string, unknown>) || {}),
      [TRACE_ID_META_KEY]: traceId,
    },
  };
}

// ============================================================================
// PAYLOAD EXTRACTION
// ============================================================================

/**
 * Extract trace ID from a payload received from an async boundary.
 *
 * This should be called when consuming messages from:
 * - QStash webhooks
 * - Ably subscriptions
 * - Redis stream consumers
 * - Any other async boundary
 *
 * @param payload - The message payload to extract trace ID from
 * @returns Trace ID if present, undefined otherwise
 *
 * @example
 * ```typescript
 * // In QStash webhook handler
 * const traceId = extractTraceFromPayload(req.body);
 * if (traceId) {
 *   tracingStorage.run({ traceId, correlationId: traceId }, () => {
 *     processWebhook(req.body);
 *   });
 * }
 * ```
 */
export function extractTraceFromPayload(
  payload: Record<string, unknown>,
): string | undefined {
  const meta = payload[TRACE_META_KEY] as Record<string, unknown> | undefined;
  return meta?.[TRACE_ID_META_KEY] as string | undefined;
}

// ============================================================================
// HEADERS EXTRACTION
// ============================================================================

/**
 * Extract trace ID from HTTP headers.
 *
 * @param headers - Headers object or record
 * @returns Trace ID if present, undefined otherwise
 */
export function extractTraceFromHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(TRACE_ID_HEADER) || undefined;
  }

  const header = headers[TRACE_ID_HEADER];
  if (Array.isArray(header)) {
    return header[0];
  }
  return header;
}

// ============================================================================
// TRACE CONTEXT RESTORATION
// ============================================================================

/**
 * Restore trace context from a payload and execute a function within it.
 *
 * This is useful for webhook handlers and message consumers that need
 * to restore the trace context before processing.
 *
 * @param payload - The message payload containing trace metadata
 * @param fn - Function to execute within the restored trace context
 * @returns Result of the function execution
 *
 * @example
 * ```typescript
 * // In a QStash webhook route
 * export const POST = withUnifiedApiHandler(async (req) => {
 *   const body = await req.json();
 *
 *   return withTraceContext(body, async () => {
 *     // This code now has access to the original trace ID
 *     await processWebhook(body);
 *     return NextResponse.json({ success: true });
 *   });
 * });
 * ```
 */
export async function withTraceContext<T>(
  payload: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const traceId = extractTraceFromPayload(payload);

  if (!traceId) {
    // No trace in payload - execute without context
    return fn();
  }

  // Restore trace context
  const existingStore = tracingStorage.getStore();
  return tracingStorage.run(
    {
      traceId,
      correlationId: existingStore?.correlationId || traceId,
      executionId: existingStore?.executionId,
    },
    () => fn(),
  );
}

// ============================================================================
// QSTASH / ASYNC PUBLISH WRAPPER
// ============================================================================

/**
 * Wrapper for QStash publish that auto-attaches trace ID.
 *
 * @param publishFn - Original QStash publish function
 * @returns Wrapped publish function with trace ID attachment
 *
 * @example
 * ```typescript
 * const publishWithTrace = withTracePublish(qstash.publishJSON.bind(qstash));
 * await publishWithTrace({ url: "...", body: { action: "notify" } });
 * ```
 */
export function withTracePublish(
  publishFn: (options: Record<string, unknown>) => Promise<unknown>,
): (options: Record<string, unknown>) => Promise<unknown> {
  return async (options: Record<string, unknown>) => {
    const body = options.body as Record<string, unknown> | string | undefined;

    if (body && typeof body === "object") {
      // Attach trace ID to body
      options.body = attachTraceToPayload(body);
    }

    return publishFn(options);
  };
}

// ============================================================================
// ABLY PUBLISH WRAPPER
// ============================================================================

/**
 * Wrapper for Ably publish that auto-attaches trace ID.
 *
 * @param channel - Ably channel
 * @returns Wrapped publish function with trace ID attachment
 *
 * @example
 * ```typescript
 * const publishWithTrace = withTraceAblyPublish(channel);
 * await publishWithTrace({ event: "reservation.confirmed", data: { ... } });
 * ```
 */
export function withTraceAblyPublish(channel: {
  publish: (event: string, message: unknown) => Promise<void>;
}): (event: string, message: unknown) => Promise<void> {
  return async (event: string, message: unknown) => {
    const enrichedMessage =
      message && typeof message === "object"
        ? attachTraceToPayload(message as Record<string, unknown>)
        : message;

    return channel.publish(event, enrichedMessage);
  };
}
