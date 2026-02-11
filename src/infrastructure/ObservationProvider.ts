import { trace, Span, SpanStatusCode, Tracer } from "@opentelemetry/api";

export class ObservationProvider {
  private tracer: Tracer;

  constructor(serviceName: string = "intention-engine") {
    this.tracer = trace.getTracer(serviceName);
  }

  /**
   * Wraps a tool execution in an OpenTelemetry span.
   */
  async traceToolExecution<T>(
    toolName: string,
    intentId: string,
    stepIndex: number,
    executionFn: () => Promise<T>
  ): Promise<T> {
    return this.tracer.startActiveSpan(`tool_execution:${toolName}`, async (span: Span) => {
      span.setAttribute("tool_name", toolName);
      span.setAttribute("intent_id", intentId);
      span.setAttribute("step_index", stepIndex);

      try {
        const result = await executionFn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error: any) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error.message,
        });
        span.recordException(error);
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
