import { trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

// Initialize OpenTelemetry
let sdk: any = null;

export function initObservability() {
  if (sdk) return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  sdk = new NodeSDK({
    spanProcessor: new SimpleSpanProcessor(new ConsoleSpanExporter()),
  });

  try {
    sdk.start();
  } catch (e) {
    // Ignore
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
