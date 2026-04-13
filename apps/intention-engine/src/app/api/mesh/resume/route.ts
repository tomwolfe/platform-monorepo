/**
 * POST /api/mesh/resume - Durable Execution Resume Endpoint
 *
 * Listens for CONTINUE_EXECUTION events from Ably to resume
 * segmented execution where a previous Vercel lambda left off.
 *
 * This bypasses Vercel's 10s timeout by chaining lambdas via Ably.
 *
 * Security: Requires service token authentication.
 * Observability: Propagates trace ID for distributed tracing.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyAsymmetricJWT } from "@repo/auth";
import {
  resumeFromCheckpoint,
  ToolExecutor,
} from "@/lib/engine/workflow-machine";
import { loadExecutionState } from "@/lib/engine/memory";
import { getMcpClients, ToolCallResult } from "@/lib/mcp-client";
import {
  RealtimeService,
  withUnifiedApiHandler,
  formatApiSuccess,
  formatApiError,
  Logger,
} from "@repo/shared";
import { Tracer } from "@/lib/engine/tracing";
import {
  getToolRegistry,
  ToolExecutionContext,
} from "@/lib/engine/tools/registry";
import { getRedisClient, ServiceNamespace } from "@repo/shared";
import { getDb } from "@repo/database";
import { Redis } from "@upstash/redis";
import type { NeonDatabase } from "drizzle-orm/neon-serverless";

const RESUME_REQUEST_SCHEMA = {
  executionId: "string (required) - The execution ID to resume",
  traceId: "string (optional) - Distributed trace ID for observability",
  force: "boolean (optional) - Force resume even if no checkpoint exists",
};

const logger = new Logger({ serviceName: "mesh-resume" });

async function meshResumeHandler(req: NextRequest) {
  const startTime = Date.now();

  // ========================================================================
  // AUTHENTICATION - Verify service token
  // ========================================================================

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.toLowerCase().startsWith("bearer ")
    ? authHeader.substring(7).trim()
    : authHeader;

  if (!token) {
    return NextResponse.json(
      formatApiError(new Error("Missing authorization token"), "UNAUTHORIZED"),
      { status: 401 },
    );
  }

  const verified = await verifyAsymmetricJWT(
    token,
    "intention-engine",
    "mesh-resume",
  );
  if (!verified) {
    return NextResponse.json(
      formatApiError(
        new Error("Invalid or expired service token"),
        "UNAUTHORIZED",
      ),
      { status: 403 },
    );
  }

  // ========================================================================
  // PARSE REQUEST
  // ========================================================================

  const body = await req.json();
  const { executionId, traceId } = body;

  if (!executionId) {
    return NextResponse.json(
      formatApiError(
        new Error("Missing required field: executionId"),
        "VALIDATION_ERROR",
        {
          details: { schema: RESUME_REQUEST_SCHEMA },
        },
      ),
      { status: 400 },
    );
  }

  logger.info("Received resume request", {
    executionId,
    traceId: traceId || undefined,
  });

  // ========================================================================
  // START TRACE
  // ========================================================================

  return await Tracer.startActiveSpan("mesh:resume_execution", async (span) => {
    span.setAttributes({
      execution_id: executionId,
      trace_id: traceId || "unknown",
      source: "mesh_resume",
    });

    // ========================================================================
    // LOAD EXECUTION STATE
    // ========================================================================

    const state = await loadExecutionState(executionId);
    if (!state) {
      return NextResponse.json(
        formatApiError(
          new Error(`No execution state found for ${executionId}`),
          "NOT_FOUND",
        ),
        { status: 404 },
      );
    }

    if (!state.plan) {
      return NextResponse.json(
        formatApiError(
          new Error("Execution has no plan associated with it"),
          "VALIDATION_ERROR",
        ),
        { status: 400 },
      );
    }

    // Check if already in terminal state
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(state.status)) {
      return NextResponse.json(
        formatApiSuccess({
          message: "Execution already in terminal state",
          status: state.status,
          completed_steps: state.step_states.filter(
            (s) => s.status === "completed",
          ).length,
          total_steps: state.plan!.steps.length,
        }),
        { status: 200 },
      );
    }

    // ========================================================================
    // BUILD TOOL EXECUTOR
    // ========================================================================

    const toolExecutor = await buildToolExecutor(traceId, executionId);

    // ========================================================================
    // RESUME EXECUTION
    // ========================================================================

    const result = await resumeFromCheckpoint(executionId, toolExecutor, {
      traceCallback: (entry) => {
        span.addEvent(entry.event, {
          step_id: entry.step_id,
          latency_ms: entry.latency_ms,
          phase: entry.phase,
        });
      },
      traceId,
    });

    // ========================================================================
    // PUBLISH COMPLETION EVENT
    // ========================================================================

    await RealtimeService.publishStreamingStatusUpdate({
      executionId,
      stepIndex: result.completedSteps,
      totalSteps: result.totalSteps,
      stepName: "execution_segment",
      status: result.success
        ? "completed"
        : result.failedSteps > 0
          ? "failed"
          : "in_progress",
      message: result.isPartial
        ? `Segment completed, ${result.completedSteps}/${result.totalSteps} steps done`
        : result.success
          ? "All steps completed successfully"
          : `Execution failed: ${result.error?.message}`,
      timestamp: new Date().toISOString(),
      traceId,
    });

    // ========================================================================
    // RESPONSE
    // ========================================================================

    const response: Record<string, unknown> = {
      executionId,
      success: result.success,
      completed_steps: result.completedSteps,
      failed_steps: result.failedSteps,
      total_steps: result.totalSteps,
      execution_time_ms: result.executionTimeMs,
      isPartial: result.isPartial || false,
      status: result.state.status,
    };

    if (result.isPartial) {
      response.message = "Execution segmented - continuation event published";
      response.nextStepIndex = result.nextStepIndex;
      response.segmentNumber = result.segmentNumber;
    } else if (result.success) {
      response.message = "Execution completed successfully";
      response.summary = result.summary;
    } else {
      response.error = result.error;
    }

    return NextResponse.json(
      formatApiSuccess(response, {
        durationMs: Date.now() - startTime,
        traceId,
      }),
      { status: 200 },
    );
  });
}

export const POST = withUnifiedApiHandler(meshResumeHandler, {
  serviceName: "mesh-resume",
  includeStackTrace: process.env.NODE_ENV !== "production",
});

// ============================================================================
// BUILD TOOL EXECUTOR
// Creates a tool executor that uses MCP clients and local tools
// ============================================================================

async function buildToolExecutor(
  traceId?: string,
  executionId?: string,
): Promise<ToolExecutor> {
  const { manager } = await getMcpClients();
  const toolRegistry = getToolRegistry();

  return {
    async execute(toolName, parameters, timeoutMs, signal) {
      const startTime = Date.now();

      try {
        // Try MCP manager first with parameter aliasing
        const result = await Promise.race([
          manager.executeTool(toolName, parameters as Record<string, unknown>),
          new Promise<ToolCallResult>((_, reject) => {
            signal?.addEventListener("abort", () => {
              reject(new Error("AbortError: Tool call cancelled"));
            });
            setTimeout(() => reject(new Error("Tool timeout")), timeoutMs);
          }),
        ]);

        if (result && "success" in result && result.success) {
          return {
            success: true,
            output: result.output,
            latency_ms: Date.now() - startTime,
          };
        }

        // Fall back to local tools if MCP fails
        const localTool = toolRegistry.getDefinition(toolName);
        if (
          !localTool ||
          !("execute" in localTool) ||
          typeof localTool.execute !== "function"
        ) {
          return {
            success: false,
            error: `Tool not found or not executable: ${toolName}`,
            latency_ms: Date.now() - startTime,
          };
        }

        logger.info("Executing local tool", { toolName });

        // Lazy-initialized services for this execution
        let _injRedis: Redis | null = null;
        let _injDb: NeonDatabase | null = null;
        const getInjRedis = (): Redis => {
          if (!_injRedis) _injRedis = getRedisClient(ServiceNamespace.SHARED);
          return _injRedis;
        };
        const getInjDb = (): NeonDatabase => {
          if (!_injDb) _injDb = getDb();
          if (!_injDb) throw new Error("Database not configured");
          return _injDb;
        };

        // Execute local tool using the engine's standard execution context
        const stepId = `resume:${toolName}:${Date.now()}`;

        try {
          const ctx: ToolExecutionContext = {
            executionId: executionId || "unknown",
            stepId,
            timeoutMs,
            startTime: Date.now(),
            services: {
              redis: getInjRedis(),
              db: getInjDb(),
            },
          };
          const output = await localTool.execute(parameters, ctx);

          return {
            success: true,
            output,
            latency_ms: Date.now() - startTime,
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          return {
            success: false,
            error: errorMessage,
            latency_ms: Date.now() - startTime,
          };
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          success: false,
          error: errorMessage,
          latency_ms: Date.now() - startTime,
        };
      }
    },
  };
}

// ============================================================================
// ABLY WEBHOOK HANDLER (Optional)
// For direct Ably webhook integration
// ============================================================================

export async function GET(_req: NextRequest) {
  // Health check endpoint
  return NextResponse.json({ status: "ok", service: "mesh-resume" });
}
