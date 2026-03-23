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
import { verifyServiceToken } from "@repo/auth";
import { resumeFromCheckpoint, ToolExecutor, WorkflowResult } from "@/lib/engine/workflow-machine";
import { loadExecutionState } from "@/lib/engine/memory";
import { getMcpClients, ToolCallResult } from "@/lib/mcp-client";
import { RealtimeService } from "@repo/shared";
import { Tracer } from "@/lib/engine/tracing";
import { getToolRegistry } from "@/lib/engine/tools/registry";
import { Plan } from "@/lib/engine/types";

const RESUME_REQUEST_SCHEMA = {
  executionId: "string (required) - The execution ID to resume",
  traceId: "string (optional) - Distributed trace ID for observability",
  force: "boolean (optional) - Force resume even if no checkpoint exists",
};

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  
  try {
    // ========================================================================
    // AUTHENTICATION - Verify service token
    // ========================================================================
    
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.replace("Bearer ", "");
    
    if (!token) {
      return NextResponse.json(
        { error: "Missing authorization token" },
        { status: 401 }
      );
    }
    
    const verified = await verifyServiceToken(token);
    if (!verified) {
      return NextResponse.json(
        { error: "Invalid or expired service token" },
        { status: 403 }
      );
    }
    
    // ========================================================================
    // PARSE REQUEST
    // ========================================================================
    
    const body = await req.json();
    const { executionId, traceId, force = false } = body;
    
    if (!executionId) {
      return NextResponse.json(
        { error: "Missing required field: executionId", schema: RESUME_REQUEST_SCHEMA },
        { status: 400 }
      );
    }
    
    console.log(
      `[MeshResume] Received resume request for ${executionId}` +
      (traceId ? ` [trace: ${traceId}]` : "")
    );
    
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
          { error: `No execution state found for ${executionId}` },
          { status: 404 }
        );
      }
      
      if (!state.plan) {
        return NextResponse.json(
          { error: "Execution has no plan associated with it" },
          { status: 400 }
        );
      }
      
      // Check if already in terminal state
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(state.status)) {
        return NextResponse.json(
          { 
            message: "Execution already in terminal state",
            status: state.status,
            completed_steps: state.step_states.filter(s => s.status === "completed").length,
            total_steps: state.plan!.steps.length,
          },
          { status: 200 }
        );
      }
      
      // ========================================================================
      // BUILD TOOL EXECUTOR
      // ========================================================================
      
      const toolExecutor = await buildToolExecutor(traceId);
      
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
        status: result.success ? "completed" : result.failedSteps > 0 ? "failed" : "in_progress",
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

      const response: any = {
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

      return NextResponse.json(response, { status: 200 });
    });

  } catch (error) {
    console.error("[MeshResume] Error resuming execution:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);

    return NextResponse.json(
      {
        error: "Failed to resume execution",
        message: errorMessage,
        stack: process.env.NODE_ENV === "development" ? (error as Error).stack : undefined,
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// BUILD TOOL EXECUTOR
// Creates a tool executor that uses MCP clients and local tools
// ============================================================================

async function buildToolExecutor(traceId?: string): Promise<ToolExecutor> {
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
            signal?.addEventListener('abort', () => {
              reject(new Error('AbortError: Tool call cancelled'));
            });
            setTimeout(() => reject(new Error('Tool timeout')), timeoutMs);
          })
        ]);

        if (result && 'success' in result && result.success) {
          return {
            success: true,
            output: result.output,
            latency_ms: Date.now() - startTime,
          };
        }

        // Fall back to local tools if MCP fails
        const localTool = toolRegistry.getDefinition(toolName);
        if (!localTool) {
          return {
            success: false,
            error: `Tool not found: ${toolName}`,
            latency_ms: Date.now() - startTime,
          };
        }

        console.log(`[MeshResume] Executing local tool ${toolName}`);

        // Execute local tool using the engine's standard execution context
        // We need to construct a proper execution context for the tool
        const executionId = state.execution_id || executionId;
        const stepId = `resume:${toolName}:${Date.now()}`;
        
        try {
          const output = await localTool.execute(parameters, { 
            executionId, 
            stepId, 
            timeoutMs,
            startTime: Date.now(),
            traceId,
          });

          return {
            success: true,
            output,
            latency_ms: Date.now() - startTime,
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            error: errorMessage,
            latency_ms: Date.now() - startTime,
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
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

export async function GET(req: NextRequest) {
  // Health check endpoint
  return NextResponse.json({ status: "ok", service: "mesh-resume" });
}
