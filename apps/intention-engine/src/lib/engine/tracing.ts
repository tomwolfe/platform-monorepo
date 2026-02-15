/**
 * IntentionEngine - Observability/Tracing
 * Phase 8: Execution tracing with latency, token, and model tracking
 */

import { trace, Span } from "@opentelemetry/api";
import {
  ExecutionTrace,
  ExecutionTraceSchema,
  TraceEntry,
  TraceEntrySchema,
  ExecutionState,
  EngineErrorSchema,
} from "./types";
import { saveExecutionTrace, loadExecutionTrace } from "./memory";

/**
 * Tracer provides a high-level API for OpenTelemetry tracing.
 */
export class Tracer {
  private static tracer = trace.getTracer("intention-engine");

  static async startActiveSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: 1 }); // OK
        return result;
      } catch (error: any) {
        span.recordException(error);
        span.setStatus({ code: 2, message: error.message }); // ERROR
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

// ============================================================================
// TRACER CONFIGURATION
// ============================================================================

export interface TracerConfig {
  maxEntries: number;
  persistToMemory: boolean;
  includeInputOutput: boolean;
}

export const DEFAULT_TRACER_CONFIG: TracerConfig = {
  maxEntries: 1000,
  persistToMemory: true,
  includeInputOutput: true,
};

// ============================================================================
// TRACER RESULT
// ============================================================================

export interface TracerResult {
  trace: ExecutionTrace;
  entryCount: number;
  totalLatencyMs: number;
  totalTokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ============================================================================
// EXECUTION TRACER
// ============================================================================

export class ExecutionTracer {
  private trace: ExecutionTrace;
  private config: TracerConfig;
  private executionId: string;

  constructor(executionId: string, config: Partial<TracerConfig> = {}) {
    this.executionId = executionId;
    this.config = { ...DEFAULT_TRACER_CONFIG, ...config };
    
    const timestamp = new Date().toISOString();
    
    this.trace = ExecutionTraceSchema.parse({
      trace_id: executionId,
      execution_id: executionId,
      entries: [],
      started_at: timestamp,
    });
  }

  addEntry(entry: Omit<TraceEntry, "timestamp"> & { timestamp?: string }): TraceEntry {
    if (this.trace.entries.length >= this.config.maxEntries) {
      console.warn(`Trace entry limit (${this.config.maxEntries}) reached, dropping entry`);
      return this.trace.entries[this.trace.entries.length - 1];
    }

    const timestamp = entry.timestamp || new Date().toISOString();
    
    const fullEntry: TraceEntry = TraceEntrySchema.parse({
      ...entry,
      timestamp,
    });

    if (!this.config.includeInputOutput) {
      const redactedEntry = {
        ...fullEntry,
        input: fullEntry.input ? "[REDACTED]" : undefined,
        output: fullEntry.output ? "[REDACTED]" : undefined,
      };
      this.trace.entries.push(redactedEntry);
    } else {
      this.trace.entries.push(fullEntry);
    }

    if (this.config.persistToMemory) {
      this.persist().catch(console.error);
    }

    return fullEntry;
  }

  addIntentEntry(
    input: string,
    output: unknown,
    latencyMs: number,
    modelId: string,
    tokenUsage?: { prompt: number; completion: number }
  ): TraceEntry {
    return this.addEntry({
      phase: "intent",
      event: "intent_parsed",
      input: { rawText: input },
      output,
      latency_ms: latencyMs,
      model_id: modelId,
      token_usage: tokenUsage
        ? {
            prompt_tokens: tokenUsage.prompt,
            completion_tokens: tokenUsage.completion,
            total_tokens: tokenUsage.prompt + tokenUsage.completion,
          }
        : undefined,
    });
  }

  addPlanningEntry(
    input: unknown,
    output: unknown,
    latencyMs: number,
    modelId: string,
    tokenUsage?: { prompt: number; completion: number }
  ): TraceEntry {
    return this.addEntry({
      phase: "planning",
      event: "plan_generated",
      input,
      output,
      latency_ms: latencyMs,
      model_id: modelId,
      token_usage: tokenUsage
        ? {
            prompt_tokens: tokenUsage.prompt,
            completion_tokens: tokenUsage.completion,
            total_tokens: tokenUsage.prompt + tokenUsage.completion,
          }
        : undefined,
    });
  }

  addExecutionEntry(
    stepId: string,
    event: "step_started" | "step_completed" | "step_failed" | "step_error",
    input: unknown,
    output?: unknown,
    error?: string,
    latencyMs?: number
  ): TraceEntry {
    return this.addEntry({
      phase: "execution",
      step_id: stepId,
      event,
      input,
      output,
      error,
      latency_ms: latencyMs,
    });
  }

  addSystemEntry(
    event: string,
    details?: unknown
  ): TraceEntry {
    return this.addEntry({
      phase: "system",
      event,
      input: details,
    });
  }

  addStateTransitionEntry(
    fromState: string,
    toState: string,
    success: boolean
  ): TraceEntry {
    return this.addEntry({
      phase: "system",
      event: "state_transition",
      input: { from: fromState, to: toState },
      output: { success },
    });
  }

  addErrorEntry(
    phase: TraceEntry["phase"],
    errorCode: string,
    errorMessage: string,
    stepId?: string,
    details?: unknown
  ): TraceEntry {
    return this.addEntry({
      phase,
      step_id: stepId,
      event: "error",
      error: errorMessage,
      input: { code: errorCode, details },
    });
  }

  finalize(): TracerResult {
    const timestamp = new Date().toISOString();
    
    const totalLatencyMs = this.trace.entries.reduce(
      (sum, entry) => sum + (entry.latency_ms || 0),
      0
    );

    const totalTokenUsage = this.trace.entries.reduce(
      (sum, entry) => {
        if (entry.token_usage) {
          return {
            promptTokens: sum.promptTokens + entry.token_usage.prompt_tokens,
            completionTokens: sum.completionTokens + entry.token_usage.completion_tokens,
            totalTokens: sum.totalTokens + entry.token_usage.total_tokens,
          };
        }
        return sum;
      },
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    );

    this.trace = ExecutionTraceSchema.parse({
      ...this.trace,
      ended_at: timestamp,
      total_latency_ms: totalLatencyMs,
      total_token_usage: {
        prompt_tokens: totalTokenUsage.promptTokens,
        completion_tokens: totalTokenUsage.completionTokens,
        total_tokens: totalTokenUsage.totalTokens,
      },
    });

    if (this.config.persistToMemory) {
      this.persist().catch(console.error);
    }

    return {
      trace: this.trace,
      entryCount: this.trace.entries.length,
      totalLatencyMs,
      totalTokenUsage,
    };
  }

  getTrace(): ExecutionTrace {
    return this.trace;
  }

  private async persist(): Promise<void> {
    try {
      await saveExecutionTrace(this.trace);
    } catch (error) {
      console.error("Failed to persist trace:", error);
    }
  }
}

export async function loadTrace(executionId: string): Promise<ExecutionTrace | null> {
  return loadExecutionTrace(executionId);
}

export function createTracer(
  executionId: string,
  config?: Partial<TracerConfig>
): ExecutionTracer {
  return new ExecutionTracer(executionId, config);
}
