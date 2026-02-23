import { injectTracingHeaders } from "@repo/shared/tracing";
import { Tracer } from "./engine/tracing";

/**
 * Enhanced fetch with automatic x-trace-id injection.
 *
 * ENHANCEMENT: OpenTelemetry Span Attributes
 * - Adds otel.span.kind = client to ensure Grafana Tempo shows inter-service calls correctly
 */
export async function fetchWithTracing(
  url: string | URL,
  options: RequestInit = {},
  executionId?: string
): Promise<Response> {
  const headers = (options.headers as Record<string, string>) || {};

  if (executionId) {
    injectTracingHeaders(headers, executionId);
  }

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
      });

      // Record response status
      span.setAttributes({
        "http.response.status_code": response.status,
      });

      return response;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  });
}
