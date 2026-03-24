/**
 * State-Diff Viewer API Endpoint
 *
 * Retrieves state diffs and timeline for a specific execution.
 * Used for visualizing saga execution progress and debugging.
 *
 * GET /api/debug/diffs/[executionId]
 *
 * Response:
 * {
 *   executionId: string;
 *   stats: {
 *     totalDiffs: number;
 *     startTime: string;
 *     endTime?: string;
 *     totalDurationMs: number;
 *     completedSteps: number;
 *     totalSteps: number;
 *     currentStatus: string;
 *   };
 *   timeline: {
 *     diffs: Array<{
 *       executionId: string;
 *       timestamp: string;
 *       previousStatus: string;
 *       currentStatus: string;
 *       budgetDelta: {
 *         tokenDelta: number;
 *         costDelta: number;
 *       };
 *       stepChanges: Array<{
 *         stepId: string;
 *         toolName: string;
 *         previousStatus?: string;
 *         currentStatus: string;
 *         changed: boolean;
 *         resultChanged?: boolean;
 *       }>;
 *       completedSteps: number;
 *       totalSteps: number;
 *       isCheckpoint: boolean;
 *     }>;
 *     stepGantt: Array<{
 *       stepId: string;
 *       toolName: string;
 *       startTime: string;
 *       endTime?: string;
 *       durationMs: number;
 *       status: string;
 *     }>;
 *   };
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { StateDiffViewer } from "../../../../lib/engine/state-diff-viewer";
import { redis } from "../../../../lib/redis-client";

// ============================================================================
// GET HANDLER
// ============================================================================

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> }
): Promise<NextResponse> {
  try {
    const { executionId } = await params;

    if (!executionId || typeof executionId !== "string") {
      return NextResponse.json(
        {
          error: "Missing or invalid executionId",
        },
        { status: 400 }
      );
    }

    // Get execution stats
    const stats = await StateDiffViewer.getExecutionStats(executionId);

    // Get timeline
    const timeline = await StateDiffViewer.generateTimeline(executionId);

    // Return result
    return NextResponse.json({
      executionId,
      stats,
      timeline: {
        executionId,
        diffs: timeline.diffs,
        startTime: timeline.startTime,
        endTime: timeline.endTime,
        totalDurationMs: timeline.totalDurationMs,
        stepGantt: timeline.stepGantt,
      },
    });
  } catch (error) {
    console.error("[StateDiff Viewer] Error:", error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to retrieve state diffs",
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// OPTIONS HANDLER (CORS)
// ============================================================================

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
