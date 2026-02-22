import { NextRequest, NextResponse } from "next/server";
import { loadExecutionTrace } from "@/lib/engine/memory";
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
          { status: 404 }
        );
      }

      return NextResponse.json(trace);
    }

    // List traces with filtering
    // Note: This is a simplified implementation. For production, you'd want
    // to implement proper indexing and pagination in the memory service.
    const traces: ExecutionTrace[] = [];
    
    // In a production implementation, you would query from a database
    // For now, this is a placeholder that returns an empty list
    // The actual implementation would depend on your storage backend
    
    return NextResponse.json({
      traces,
      total: traces.length,
      hasMore: false,
      query: params,
    });
  } catch (error: any) {
    console.error("[DebugTraces] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch traces", message: error.message },
      { status: 500 }
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
      return NextResponse.json(
        { error: "Trace is required" },
        { status: 400 }
      );
    }

    // In production, you would validate the trace schema here
    // For now, we trust the input (this is a debug endpoint)
    
    console.log("[DebugTraces] Received trace:", trace.execution_id || trace.trace_id);
    
    return NextResponse.json({
      success: true,
      message: "Trace received (storage implementation pending)",
    });
  } catch (error: any) {
    console.error("[DebugTraces] Error:", error);
    return NextResponse.json(
      { error: "Failed to store trace", message: error.message },
      { status: 500 }
    );
  }
}
