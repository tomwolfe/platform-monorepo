import { NextRequest, NextResponse } from "next/server";
import { loadExecutionTrace, getMemoryClient } from "@/lib/engine/memory";

/**
 * GET /api/debug/traces/[traceId]
 *
 * Fetch a specific execution trace by ID
 * This provides detailed waterfall visualization data for support teams
 *
 * ENHANCEMENT: State-Diff Trace Viewer
 * - Includes state snapshots at each step
 * - Computes diff between consecutive states
 * - Shows exactly which keys changed during each step (Redux DevTools style)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ traceId: string }> }
) {
  try {
    const { traceId } = await params;
    const includeStateDiffs = request.nextUrl.searchParams.get("includeStateDiffs") === "true";

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

    // ENHANCEMENT: Add state diffs if requested
    if (includeStateDiffs) {
      enrichedTrace.stateDiffs = await computeStateDiffs(traceId);
    }

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

/**
 * ENHANCEMENT: State-Diff Trace Viewer (Redux DevTools style)
 *
 * Computes the diff between consecutive execution states to show exactly
 * which keys changed during each step. This is critical for debugging
 * distributed agent state mutations.
 *
 * @param traceId - The trace ID (also execution ID)
 * @returns Array of state diffs for each step
 */
async function computeStateDiffs(traceId: string): Promise<Array<{
  stepId: string;
  timestamp: string;
  previousState?: Record<string, any>;
  newState?: Record<string, any>;
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: Array<{
    key: string;
    oldValue: any;
    newValue: any;
  }>;
  unchangedKeys: string[];
}>> {
  try {
    const memoryClient = getMemoryClient();
    if (!memoryClient) {
      console.warn("[computeStateDiffs] Memory client not available");
      return [];
    }

    // Load execution state from Redis
    const taskState = await memoryClient.getTaskState(traceId);
    if (!taskState) {
      console.warn(`[computeStateDiffs] No task state found for ${traceId}`);
      return [];
    }

    // Extract state snapshots from transitions
    const stateSnapshots: Array<{
      stepId?: string;
      timestamp: string;
      state: Record<string, any>;
    }> = [];

    // Build snapshots from task state transitions
    for (const transition of taskState.transitions || []) {
      const snapshot: any = {
        stepId: transition.metadata?.stepId as string | undefined,
        timestamp: transition.timestamp,
        state: {
          status: transition.to_status,
          current_step_index: taskState.current_step_index,
          segment_number: taskState.segment_number,
        },
      };

      // Include context changes
      if (transition.metadata?.contextChanges) {
        snapshot.state.contextChanges = transition.metadata.contextChanges;
      }

      stateSnapshots.push(snapshot);
    }

    // If no snapshots from transitions, create from step results in context
    if (stateSnapshots.length === 0) {
      const stepResults = Object.entries(taskState.context)
        .filter(([key]) => key.startsWith('step_result:'))
        .map(([key, value]) => ({
          stepId: key.replace('step_result:', ''),
          timestamp: taskState.updated_at,
          state: { step_result: value },
        }));

      stateSnapshots.push(...stepResults);
    }

    // Compute diffs between consecutive snapshots
    const stateDiffs: any[] = [];
    let previousState: Record<string, any> | null = null;

    for (const snapshot of stateSnapshots) {
      if (previousState) {
        const diff = computeObjectDiff(previousState, snapshot.state);
        stateDiffs.push({
          stepId: snapshot.stepId || 'unknown',
          timestamp: snapshot.timestamp,
          previousState,
          newState: snapshot.state,
          ...diff,
        });
      }

      previousState = snapshot.state;
    }

    return stateDiffs;
  } catch (error) {
    console.error("[computeStateDiffs] Error computing state diffs:", error);
    return [];
  }
}

/**
 * Compute the diff between two objects
 * Returns added, removed, changed, and unchanged keys
 */
function computeObjectDiff(
  prev: Record<string, any>,
  curr: Record<string, any>
): {
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: Array<{ key: string; oldValue: any; newValue: any }>;
  unchangedKeys: string[];
} {
  const prevKeys = new Set(Object.keys(prev));
  const currKeys = new Set(Object.keys(curr));

  const addedKeys: string[] = [];
  const removedKeys: string[] = [];
  const changedKeys: Array<{ key: string; oldValue: any; newValue: any }> = [];
  const unchangedKeys: string[] = [];

  // Find added keys
  for (const key of currKeys) {
    if (!prevKeys.has(key)) {
      addedKeys.push(key);
    }
  }

  // Find removed keys
  for (const key of prevKeys) {
    if (!currKeys.has(key)) {
      removedKeys.push(key);
    }
  }

  // Find changed and unchanged keys
  for (const key of prevKeys) {
    if (currKeys.has(key)) {
      const prevValue = prev[key];
      const currValue = curr[key];

      if (JSON.stringify(prevValue) !== JSON.stringify(currValue)) {
        changedKeys.push({ key, oldValue: prevValue, newValue: currValue });
      } else {
        unchangedKeys.push(key);
      }
    }
  }

  return { addedKeys, removedKeys, changedKeys, unchangedKeys };
}
