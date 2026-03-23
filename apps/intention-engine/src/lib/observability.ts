import { trace, context } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter, SimpleSpanProcessor, BatchSpanProcessor, SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

// Initialize OpenTelemetry
let sdk: any = null;

/**
 * DualExporter - exports to both OTLP and Console (for development debugging)
 */
class DualExporter implements SpanExporter {
  private otlpExporter: OTLPTraceExporter;
  private consoleExporter: ConsoleSpanExporter;

  constructor(otlpExporter: OTLPTraceExporter, consoleExporter: ConsoleSpanExporter) {
    this.otlpExporter = otlpExporter;
    this.consoleExporter = consoleExporter;
  }

  export(spans: ReadableSpan[], callback: () => void): void {
    // Export to both OTLP and console
    this.otlpExporter.export(spans, () => {});
    this.consoleExporter.export(spans, callback);
  }

  async shutdown(): Promise<void> {
    await this.otlpExporter.shutdown();
    await this.consoleExporter.shutdown();
  }
}

export function initObservability() {
  if (sdk) return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const isDevelopment = process.env.NODE_ENV === 'development';

  // Configure OTLP exporter for Grafana Tempo
  // Points to otel-collector in docker-compose.yml (port 4318 for HTTP)
  const otlpExporter = new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
    headers: {},
    concurrencyLimit: 10,
  });

  // In development, also log to console for debugging
  // In production, only use OTLP exporter
  const spanExporter: SpanExporter = isDevelopment 
    ? new DualExporter(otlpExporter, new ConsoleSpanExporter())
    : otlpExporter;

  sdk = new NodeSDK({
    resource: new Resource({
      [SEMRESATTRS_SERVICE_NAME]: 'intention-engine',
    }),
    spanProcessor: new BatchSpanProcessor(spanExporter, {
      maxQueueSize: 100,
      scheduledDelayMillis: 1000,
      exportTimeoutMillis: 30000,
      maxExportBatchSize: 10,
    }),
  });

  try {
    sdk.start();
    console.log('[Observability] OpenTelemetry SDK initialized with OTLP exporter');
    if (isDevelopment) {
      console.log('[Observability] Console export enabled for development debugging');
    }
  } catch (e) {
    console.warn('[Observability] Failed to start OpenTelemetry SDK:', e);
  }
}

// Call it, but it might do nothing during build
initObservability();

export const tracer = trace.getTracer("intention-engine");

export function startTrace(name: string, traceId: string) {
  return tracer.startSpan(name, {
    attributes: { "x-trace-id": traceId },
  });
}
