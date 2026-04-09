/**
 * Web3 Provider Tracing Wrapper
 *
 * Injects OpenTelemetry trace spans around viem public client calls.
 * This ensures Web3 RPC calls are visible in the distributed tracing hierarchy,
 * making it possible to correlate blockchain operations with request-level traces.
 *
 * Usage:
 * ```typescript
 * const publicClient = await getPublicClient(chainId);
 * const tracedClient = createTracedPublicClient(publicClient, 'payout-cron');
 *
 * // All calls are now automatically traced
 * const receipt = await tracedClient.waitForTransactionReceipt({ hash });
 * ```
 *
 * @package @repo/shared
 */

import { trace, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { PublicClient } from "viem";
import { Logger } from "../logger";

const logger = new Logger({ serviceName: "web3-tracer" });

// ============================================================================
// TYPES
// ============================================================================

export interface TracedPublicClientOptions {
  /** Original viem PublicClient */
  client: PublicClient;
  /** Service name for span attribution (e.g., 'payout-cron', 'verify-pending') */
  serviceName: string;
  /** Optional custom tracer name */
  tracerName?: string;
}

export type TracedWaitForTxReceiptFn =
  PublicClient["waitForTransactionReceipt"];
export type TracedGetTxReceiptFn = PublicClient["getTransactionReceipt"];
export type TracedGetBlockNumberFn = PublicClient["getBlockNumber"];
export type TracedGetBalanceFn = PublicClient["getBalance"];
export type TracedGetTransactionCountFn = PublicClient["getTransactionCount"];

// ============================================================================
// TRACED PUBLIC CLIENT
// ============================================================================

/**
 * Create a traced wrapper around a viem PublicClient.
 *
 * Wraps the most commonly used Web3 read operations with OpenTelemetry spans:
 * - waitForTransactionReceipt
 * - getTransactionReceipt
 * - getBlockNumber
 * - getBalance
 * - getTransactionCount
 *
 * The wrapper propagates the current trace context to these spans,
 * ensuring they appear as children of the incoming request's trace.
 */
export function createTracedPublicClient(options: TracedPublicClientOptions): {
  /** Wrapped waitForTransactionReceipt with tracing */
  waitForTransactionReceipt: TracedWaitForTxReceiptFn;
  /** Wrapped getTransactionReceipt with tracing */
  getTransactionReceipt: TracedGetTxReceiptFn;
  /** Wrapped getBlockNumber with tracing */
  getBlockNumber: TracedGetBlockNumberFn;
  /** Wrapped getBalance with tracing */
  getBalance: TracedGetBalanceFn;
  /** Wrapped getTransactionCount with tracing */
  getTransactionCount: TracedGetTransactionCountFn;
  /** Access to the original client */
  client: PublicClient;
} {
  const { client, serviceName, tracerName = "web3-public-client" } = options;
  const tracer = trace.getTracer(tracerName);

  /**
   * Wrap a client method with an OpenTelemetry span
   */
  function wrapWithSpan<TArgs extends unknown[], TResult>(
    methodName: string,
    fn: (...args: TArgs) => Promise<TResult>,
  ): (...args: TArgs) => Promise<TResult> {
    return async (...args: TArgs): Promise<TResult> => {
      return tracer.startActiveSpan(
        `${serviceName}.${methodName}`,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            "rpc.method": methodName,
            "rpc.service": serviceName,
            "rpc.system": "web3",
          },
        },
        context.active(),
        async (span) => {
          try {
            const result = await fn(...args);

            // Add tx hash to span if available in args or result
            const txHash = (args[0] as any)?.hash;
            if (txHash) {
              span.setAttribute("web3.transaction.hash", txHash);
            }

            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (error) {
            span.recordException(
              error instanceof Error ? error : new Error(String(error)),
            );
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error instanceof Error ? error.message : String(error),
            });
            throw error;
          } finally {
            span.end();
          }
        },
      );
    };
  }

  return {
    waitForTransactionReceipt: wrapWithSpan(
      "waitForTransactionReceipt",
      client.waitForTransactionReceipt.bind(client),
    ),
    getTransactionReceipt: wrapWithSpan(
      "getTransactionReceipt",
      client.getTransactionReceipt.bind(client),
    ),
    getBlockNumber: wrapWithSpan(
      "getBlockNumber",
      client.getBlockNumber.bind(client),
    ),
    getBalance: wrapWithSpan("getBalance", client.getBalance.bind(client)),
    getTransactionCount: wrapWithSpan(
      "getTransactionCount",
      client.getTransactionCount.bind(client),
    ),
    client,
  };
}

/**
 * Helper: Get the trace ID from the current active span.
 * Useful for logging or passing trace IDs to external services.
 */
export function getCurrentTraceId(): string | undefined {
  const currentSpan = trace.getActiveSpan();
  if (!currentSpan) return undefined;

  const spanContext = currentSpan.spanContext();
  return spanContext.traceId !== "00000000000000000000000000000000"
    ? spanContext.traceId
    : undefined;
}

/**
 * Helper: Log Web3 operation with trace context.
 * Combines the Logger with the current trace ID for correlated logging.
 */
export function logWithTraceContext(
  logger: Logger,
  level: "info" | "warn" | "error" | "debug",
  message: string,
  metadata?: Record<string, unknown>,
): void {
  const traceId = getCurrentTraceId();
  logger[level]({
    message,
    traceId,
    ...metadata,
  });
}
