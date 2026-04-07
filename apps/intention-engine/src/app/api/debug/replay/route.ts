/**
 * Time-Travel Replay API Endpoint
 *
 * Enables replaying execution from a specific step in a trace.
 * Used for debugging and testing complex saga orchestrations.
 *
 * POST /api/debug/replay
 *
 * Request:
 * {
 *   traceId: string;
 *   stepIndex: number;
 *   options?: {
 *     mockLLM?: boolean;
 *     mockTools?: string[];
 *     parameterOverrides?: Record<string, unknown>;
 *     skipSteps?: string[];
 *     stopAfterStep?: string;
 *     verbose?: boolean;
 *   };
 * }
 *
 * Response:
 * {
 *   success: boolean;
 *   replayedFrom: {
 *     stepIndex: number;
 *     stepId: string;
 *     timestamp: string;
 *   };
 *   replayedTo?: {
 *     stepIndex: number;
 *     stepId: string;
 *     timestamp: string;
 *   };
 *   stepsReplayed: number;
 *   stepsSkipped: number;
 *   differences: Array<{
 *     stepId: string;
 *     original: unknown;
 *     replay: unknown;
 *     field: string;
 *   }>;
 *   error?: string;
 *   replayId: string;
 *   durationMs: number;
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { createReplayEngine, type ReplayOptions } from "@/lib/engine/time-travel-debugger";
import { withApiErrorHandler, Logger } from "@repo/shared";

const logger = new Logger({ serviceName: "debug-replay" });

// ============================================================================
// REQUEST SCHEMA
// ============================================================================

interface ReplayRequest {
  traceId: string;
  stepIndex: number;
  options?: Partial<ReplayOptions>;
}

// ============================================================================
// POST HANDLER
// ============================================================================

async function postHandler(request: NextRequest): Promise<NextResponse> {
  // Parse request body
  const body = await request.json().catch(() => null);

  if (!body) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid request body",
      },
      { status: 400 }
    );
  }

  // Validate required fields
  const { traceId, stepIndex, options } = body as ReplayRequest;

  if (!traceId || typeof traceId !== "string") {
    return NextResponse.json(
      {
        success: false,
        error: "Missing or invalid traceId",
      },
      { status: 400 }
    );
  }

  if (stepIndex === undefined || typeof stepIndex !== "number" || stepIndex < 0) {
    return NextResponse.json(
      {
        success: false,
        error: "Missing or invalid stepIndex",
      },
      { status: 400 }
    );
  }

  // Create replay engine
  const replayEngine = createReplayEngine(traceId, stepIndex, {
    mockLLM: options?.mockLLM ?? true,
    mockTools: options?.mockTools ?? [],
    parameterOverrides: options?.parameterOverrides,
    skipSteps: options?.skipSteps,
    stopAfterStep: options?.stopAfterStep,
    verbose: options?.verbose ?? false,
  });

  // Execute replay
  const result = await replayEngine.replayFromStep();

  // Return result
  return NextResponse.json({
    success: result.success,
    replayedFrom: result.replayedFrom,
    replayedTo: result.replayedTo,
    stepsReplayed: result.stepsReplayed,
    stepsSkipped: result.stepsSkipped,
    differences: result.differences,
    error: result.error,
    replayId: result.replayId,
    durationMs: result.durationMs,
  });
}

export const POST = withApiErrorHandler(postHandler, { serviceName: 'debug-replay' });

// ============================================================================
// OPTIONS HANDLER (CORS)
// ============================================================================

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
