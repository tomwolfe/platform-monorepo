import { NextRequest, NextResponse } from "next/server";
import { loadExecutionTrace, getMemoryClientSafe } from "@/lib/engine/memory";
import { ExecutionTrace } from "@/lib/engine/types";

export interface TraceQueryParams {
  executionId?: string;
  limit?: number;
  startTime?: string;
  endTime?: string;
  phase?: string;
}

export interface TraceListResponse {
  traces: ExecutionTrace[];
  total: number;
  hasMore: boolean;
}

/**
 * GET /api/debug/traces
 *
 * Query and list execution traces with optional filtering
 *
 * Query Parameters:
 * - executionId: Filter by specific execution ID
 * - limit: Maximum number of traces to return (default: 50, max: 100)
 * - startTime: Filter traces started after this ISO timestamp
 * - endTime: Filter traces started before this ISO timestamp
 * - phase: Filter by execution phase (intent, planning, execution, system)
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    const params: TraceQueryParams = {
      executionId: searchParams.get("executionId") || undefined,
      limit: Math.min(parseInt(searchParams.get("limit") || "50"), 100),
      startTime: searchParams.get("startTime") || undefined,
      endTime: searchParams.get("endTime") || undefined,
      phase: searchParams.get("phase") || undefined,
    };

    // If specific execution ID is provided, return single trace
    if (params.executionId) {
      const trace = await loadExecutionTrace(params.executionId);

      if (!trace) {
        return NextResponse.json(
          { error: "Trace not found", executionId: params.executionId },
          { status: 404 },
        );
      }

      return NextResponse.json(trace);
    }

    // List traces with filtering from Redis
    const memoryClient = getMemoryClientSafe();

    if (!memoryClient) {
      return NextResponse.json({
        traces: [],
        total: 0,
        hasMore: false,
        query: params,
        warning: "Memory client unavailable",
      });
    }

    // Query all execution traces from Redis
    const entries = await memoryClient.query({
      namespace: "*",
      type: "execution_trace",
      limit: params.limit ?? 50,
    });

    let traces = entries.map((entry) => entry.data as ExecutionTrace);

    // Apply time-based filtering
    if (params.startTime) {
      const start = new Date(params.startTime).getTime();
      traces = traces.filter((t) => new Date(t.started_at).getTime() >= start);
    }
    if (params.endTime) {
      const end = new Date(params.endTime).getTime();
      traces = traces.filter((t) => new Date(t.started_at).getTime() <= end);
    }

    // Apply phase filtering (check if any entries match the phase)
    if (params.phase) {
      traces = traces.filter((t) =>
        t.entries.some((e) => e.phase === params.phase),
      );
    }

    // Sort by started_at descending (most recent first)
    traces.sort(
      (a, b) =>
        new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
    );

    const hasMore = traces.length >= (params.limit || 50);

    return NextResponse.json({
      traces: traces.slice(0, params.limit),
      total: traces.length,
      hasMore,
      query: params,
    });
  } catch (error) {
    console.error("[DebugTraces] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to fetch traces", message: errorMessage },
      { status: 500 },
    );
  }
}

/**
 * POST /api/debug/traces
 *
 * Store a new execution trace (for testing/debugging purposes)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { trace } = body;

    if (!trace) {
      return NextResponse.json({ error: "Trace is required" }, { status: 400 });
    }

    // In production, you would validate the trace schema here
    // For now, we trust the input (this is a debug endpoint)

    console.log(
      "[DebugTraces] Received trace:",
      trace.execution_id || trace.trace_id,
    );

    return NextResponse.json({
      success: true,
      message: "Trace received (storage implementation pending)",
    });
  } catch (error) {
    console.error("[DebugTraces] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to store trace", message: errorMessage },
      { status: 500 },
    );
  }
}
