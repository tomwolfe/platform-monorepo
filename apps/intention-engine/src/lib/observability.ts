import { trace, context } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ConsoleSpanExporter,
  BatchSpanProcessor,
  SpanExporter,
  ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { registerObservabilityFlush, Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "observability" });

// Initialize OpenTelemetry
let sdk: NodeSDK | null = null;

/**
 * DualExporter - exports to both OTLP and Console (for development debugging)
 */
class DualExporter implements SpanExporter {
  private otlpExporter: OTLPTraceExporter;
  private consoleExporter: ConsoleSpanExporter;

  constructor(
    otlpExporter: OTLPTraceExporter,
    consoleExporter: ConsoleSpanExporter,
  ) {
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

/**
 * Initialize OpenTelemetry SDK.
 * Should be called from Next.js instrumentation.ts register() function.
 */
export function initObservability(serviceName = "intention-engine") {
  if (sdk) return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const isDevelopment = process.env.NODE_ENV === "development";

  // Configure OTLP exporter for Grafana Tempo
  // Points to otel-collector in docker-compose.yml (port 4318 for HTTP)
  const otlpExporter = new OTLPTraceExporter({
    url:
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      "http://localhost:4318/v1/traces",
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
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
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
    logger.info({
      message: "OpenTelemetry SDK initialized",
      serviceName,
      environment: process.env.NODE_ENV,
    });

    // Register the flush function with shared error handler
    registerObservabilityFlush(async () => {
      if (sdk) {
        await sdk.forceFlush();
      }
    });
  } catch (e) {
    logger.error({
      message: "Failed to start OpenTelemetry SDK",
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export const tracer = trace.getTracer("intention-engine");

export function startTrace(name: string, traceId: string) {
  return tracer.startSpan(name, {
    attributes: { "x-trace-id": traceId },
  });
}

/**
 * Force flush all pending spans to the exporter.
 *
 * CRITICAL FOR SERVERLESS: In serverless environments (Vercel, AWS Lambda),
 * the container is frozen immediately after the HTTP response is sent.
 * Any spans still in the batch buffer will be dropped and never exported.
 *
 * Call this function at the end of request handlers to ensure all spans
 * are flushed before the response is sent.
 *
 * @returns Promise that resolves when all spans have been flushed
 */
export async function flushObservability(): Promise<void> {
  if (sdk) {
    try {
      await sdk.forceFlush();
    } catch (error) {
      logger.warn({
        message: "Failed to flush spans",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
