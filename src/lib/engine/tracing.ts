/**
 * IntentionEngine - Observability/Tracing
 * Phase 8: Execution tracing with latency, token, and model tracking
 * 
 * Constraints:
 * - ExecutionTrace object per execution
 * - Latency recording at step level
 * - Token recording per LLM call
 * - Model recording
 * - Trace returned via API
 * - No overwriting trace data
 */

import {
  ExecutionTrace,
  ExecutionTraceSchema,
  TraceEntry,
  TraceEntrySchema,
  ExecutionState,
  EngineErrorSchema,
} from "./types";
import { saveExecutionTrace, loadExecutionTrace } from "./memory";

// ============================================================================
// TRACER CONFIGURATION
// Configuration options for the tracer
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
// Result of trace operations
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
// Main tracing class for collecting execution events
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

  /**
   * Add a trace entry
   */
  addEntry(entry: Omit<TraceEntry, "timestamp"> & { timestamp?: string }): TraceEntry {
    // Check max entries limit
    if (this.trace.entries.length >= this.config.maxEntries) {
      console.warn(`Trace entry limit (${this.config.maxEntries}) reached, dropping entry`);
      return this.trace.entries[this.trace.entries.length - 1];
    }

    const timestamp = entry.timestamp || new Date().toISOString();
    
    const fullEntry: TraceEntry = TraceEntrySchema.parse({
      ...entry,
      timestamp,
    });

    // Optionally redact input/output for privacy
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

    // Persist if configured
    if (this.config.persistToMemory) {
      this.persist().catch(console.error);
    }

    return fullEntry;
  }

  /**
   * Add intent parsing trace entry
   */
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
      input: { raw_input: input },
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

  /**
   * Add planning trace entry
   */
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

  /**
   * Add execution step trace entry
   */
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

  /**
   * Add system trace entry
   */
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

  /**
   * Add state transition trace entry
   */
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

  /**
   * Add error trace entry
   */
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

  /**
   * Finalize the trace
   */
  finalize(): TracerResult {
    const timestamp = new Date().toISOString();
    
    // Calculate totals
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

    // Update trace
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

    // Final persist
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

  /**
   * Get the current trace
   */
  getTrace(): ExecutionTrace {
    return this.trace;
  }

  /**
   * Get trace as JSON string
   */
  toJSON(): string {
    return JSON.stringify(this.trace, null, 2);
  }

  /**
   * Get trace summary
   */
  getSummary(): {
    executionId: string;
    entryCount: number;
    durationMs: number;
    phases: Record<string, number>;
    errors: number;
  } {
    const now = new Date().toISOString();
    const startTime = new Date(this.trace.started_at).getTime();
    const endTime = this.trace.ended_at
      ? new Date(this.trace.ended_at).getTime()
      : new Date(now).getTime();

    const phases: Record<string, number> = {};
    let errors = 0;

    for (const entry of this.trace.entries) {
      phases[entry.phase] = (phases[entry.phase] || 0) + 1;
      if (entry.event === "error" || entry.error) {
        errors++;
      }
    }

    return {
      executionId: this.executionId,
      entryCount: this.trace.entries.length,
      durationMs: endTime - startTime,
      phases,
      errors,
    };
  }

  /**
   * Persist trace to memory
   */
  private async persist(): Promise<void> {
    try {
      await saveExecutionTrace(this.trace);
    } catch (error) {
      console.error("Failed to persist trace:", error);
    }
  }
}

// ============================================================================
// TRACE LOADER
// Load traces from memory
// ============================================================================

export async function loadTrace(executionId: string): Promise<ExecutionTrace | null> {
  return loadExecutionTrace(executionId);
}

// ============================================================================
// TRACE ANALYZER
// Analyze traces for patterns and insights
// ============================================================================

export interface TraceAnalysis {
  totalExecutions: number;
  averageDurationMs: number;
  averageLatencyPerPhase: Record<string, number>;
  totalTokensUsed: { prompt: number; completion: number };
  errorRate: number;
  mostUsedModels: Array<{ modelId: string; count: number }>;
  bottleneckPhases: string[];
}

export function analyzeTraces(traces: ExecutionTrace[]): TraceAnalysis {
  if (traces.length === 0) {
    return {
      totalExecutions: 0,
      averageDurationMs: 0,
      averageLatencyPerPhase: {},
      totalTokensUsed: { prompt: 0, completion: 0 },
      errorRate: 0,
      mostUsedModels: [],
      bottleneckPhases: [],
    };
  }

  // Calculate averages
  const totalDuration = traces.reduce((sum, trace) => {
    if (trace.started_at && trace.ended_at) {
      return sum + (new Date(trace.ended_at).getTime() - new Date(trace.started_at).getTime());
    }
    return sum;
  }, 0);

  // Phase latency
  const phaseLatencies: Record<string, number[]> = {};
  for (const trace of traces) {
    for (const entry of trace.entries) {
      if (entry.latency_ms) {
        if (!phaseLatencies[entry.phase]) {
          phaseLatencies[entry.phase] = [];
        }
        phaseLatencies[entry.phase].push(entry.latency_ms);
      }
    }
  }

  const averageLatencyPerPhase: Record<string, number> = {};
  for (const [phase, latencies] of Object.entries(phaseLatencies)) {
    averageLatencyPerPhase[phase] = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  }

  // Token usage
  const totalTokensUsed = traces.reduce(
    (sum, trace) => {
      if (trace.total_token_usage) {
        return {
          prompt: sum.prompt + trace.total_token_usage.prompt_tokens,
          completion: sum.completion + trace.total_token_usage.completion_tokens,
        };
      }
      return sum;
    },
    { prompt: 0, completion: 0 }
  );

  // Error rate
  const totalErrors = traces.reduce((sum, trace) => {
    return sum + trace.entries.filter((e) => e.event === "error" || e.error).length;
  }, 0);
  const totalEntries = traces.reduce((sum, trace) => sum + trace.entries.length, 0);
  const errorRate = totalEntries > 0 ? totalErrors / totalEntries : 0;

  // Most used models
  const modelCounts: Record<string, number> = {};
  for (const trace of traces) {
    for (const entry of trace.entries) {
      if (entry.model_id) {
        modelCounts[entry.model_id] = (modelCounts[entry.model_id] || 0) + 1;
      }
    }
  }
  const mostUsedModels = Object.entries(modelCounts)
    .map(([modelId, count]) => ({ modelId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Identify bottleneck phases (above average latency)
  const avgLatency = Object.values(averageLatencyPerPhase).reduce((a, b) => a + b, 0) / Object.keys(phaseLatencies).length;
  const bottleneckPhases = Object.entries(averageLatencyPerPhase)
    .filter(([, latency]) => latency > avgLatency * 1.5)
    .map(([phase]) => phase);

  return {
    totalExecutions: traces.length,
    averageDurationMs: totalDuration / traces.length,
    averageLatencyPerPhase,
    totalTokensUsed,
    errorRate,
    mostUsedModels,
    bottleneckPhases,
  };
}

// ============================================================================
// EXPORT FACTORY
// Convenience function to create tracer
// ============================================================================

export function createTracer(
  executionId: string,
  config?: Partial<TracerConfig>
): ExecutionTracer {
  return new ExecutionTracer(executionId, config);
}
