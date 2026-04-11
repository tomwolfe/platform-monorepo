import { injectTracingHeaders } from "@repo/shared/tracing";
import { Tracer } from "./engine/tracing";

/**
 * Enhanced fetch with automatic x-trace-id injection and AbortSignal support.
 *
 * ENHANCEMENT: OpenTelemetry Span Attributes
 * - Adds otel.span.kind = client to ensure Grafana Tempo shows inter-service calls correctly
 *
 * ABORT SIGNAL: Accepts an optional AbortSignal to allow parent contexts to cancel
 * in-flight requests, preventing resource leaks after timeouts.
 */
export async function fetchWithTracing(
  url: string | URL,
  options: RequestInit = {},
  executionId?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = (options.headers as Record<string, string>) || {};

  if (executionId) {
    injectTracingHeaders(headers, executionId);
  }

  // Merge both signals using AbortSignal.any() so neither is dropped.
  // If only one is provided, use it directly to avoid unnecessary wrapper overhead.
  const signalsToCombine = [signal, options.signal].filter(
    (s): s is AbortSignal => !!s,
  );
  const effectiveSignal =
    signalsToCombine.length > 1
      ? AbortSignal.any(signalsToCombine)
      : signalsToCombine[0];

  // Wrap fetch in tracing span with otel.span.kind attribute
  return Tracer.startActiveSpan("fetch", async (span) => {
    // Set OpenTelemetry standard attributes
    span.setAttributes({
      "otel.span.kind": "client",
      "url.full": url.toString(),
      "http.method": options.method || "GET",
    });

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: effectiveSignal,
      });

      // Record response status
      span.setAttributes({
        "http.response.status_code": response.status,
      });

      return response;
    } catch (error) {
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  });
}
