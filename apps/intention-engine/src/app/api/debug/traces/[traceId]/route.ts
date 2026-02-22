import { NextRequest, NextResponse } from "next/server";
import { loadExecutionTrace } from "@/lib/engine/memory";

/**
 * GET /api/debug/traces/[traceId]
 * 
 * Fetch a specific execution trace by ID
 * This provides detailed waterfall visualization data for support teams
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ traceId: string }> }
) {
  try {
    const { traceId } = await params;
    
    if (!traceId) {
      return NextResponse.json(
        { error: "Trace ID is required" },
        { status: 400 }
      );
    }

    const trace = await loadExecutionTrace(traceId);

    if (!trace) {
      return NextResponse.json(
        { 
          error: "Trace not found", 
          traceId,
          hint: "Traces may be expired or not yet persisted. Check if the execution is still in progress.",
        },
        { status: 404 }
      );
    }

    // Enrich trace with computed metrics
    const enrichedTrace = enrichTrace(trace);

    return NextResponse.json(enrichedTrace);
  } catch (error: any) {
    console.error("[DebugTraceById] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch trace", message: error.message },
      { status: 500 }
    );
  }
}

/**
 * Enrich trace with computed metrics for visualization
 */
function enrichTrace(trace: any) {
  const entries = trace.entries || [];
  
  // Calculate step-level metrics
  const stepMetrics = new Map<string, {
    startTime: number;
    endTime: number;
    latencyMs: number;
    status: 'pending' | 'success' | 'failed' | 'error';
    error?: string;
  }>();

  entries.forEach((entry: any, index: number) => {
    if (!entry.step_id) return;

    const timestamp = new Date(entry.timestamp || trace.started_at).getTime();
    
    if (!stepMetrics.has(entry.step_id)) {
      stepMetrics.set(entry.step_id, {
        startTime: timestamp,
        endTime: timestamp,
        latencyMs: 0,
        status: 'pending',
      });
    }

    const step = stepMetrics.get(entry.step_id)!;
    
    if (entry.event === 'step_started') {
      step.startTime = timestamp;
      step.status = 'pending';
    } else if (entry.event === 'step_completed') {
      step.endTime = timestamp;
      step.latencyMs = step.endTime - step.startTime;
      step.status = 'success';
    } else if (entry.event === 'step_failed' || entry.event === 'step_error') {
      step.endTime = timestamp;
      step.latencyMs = step.endTime - step.startTime;
      step.status = entry.event === 'step_failed' ? 'failed' : 'error';
      step.error = entry.error;
    }

    if (entry.latency_ms) {
      step.latencyMs = entry.latency_ms;
    }
  });

  // Calculate aggregate metrics
  const totalSteps = stepMetrics.size;
  const successfulSteps = Array.from(stepMetrics.values()).filter(s => s.status === 'success').length;
  const failedSteps = Array.from(stepMetrics.values()).filter(s => s.status === 'failed' || s.status === 'error').length;
  
  const totalLatencyMs = entries.reduce((sum: number, entry: any) => 
    sum + (entry.latency_ms || 0), 0
  );

  const tokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  entries.forEach((entry: any) => {
    if (entry.token_usage) {
      tokenUsage.promptTokens += entry.token_usage.prompt_tokens || 0;
      tokenUsage.completionTokens += entry.token_usage.completion_tokens || 0;
      tokenUsage.totalTokens += entry.token_usage.total_tokens || 0;
    }
  });

  return {
    ...trace,
    _enriched: true,
    metrics: {
      totalSteps,
      successfulSteps,
      failedSteps,
      totalLatencyMs,
      tokenUsage,
      stepDetails: Object.fromEntries(stepMetrics),
    },
    waterfall: entries.map((entry: any, index: number) => ({
      id: `${entry.step_id || 'root'}-${index}`,
      stepId: entry.step_id,
      phase: entry.phase,
      event: entry.event,
      startTime: new Date(entry.timestamp || trace.started_at).getTime(),
      duration: entry.latency_ms || 0,
      status: entry.error ? 'error' : entry.event.includes('completed') ? 'success' : entry.event.includes('started') ? 'pending' : 'complete',
      error: entry.error,
      hasInput: !!entry.input,
      hasOutput: !!entry.output,
    })),
  };
}
