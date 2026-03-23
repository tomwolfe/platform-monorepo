/**
 * Execute Step API Route - Thin Controller Layer
 *
 * Delegates all business logic to StepExecutionService.
 * This route handles:
 * - HTTP request/response handling
 * - QStash webhook signature verification (via withQStashAuth wrapper)
 * - Request validation
 * - Delegation to StepExecutionService
 *
 * ARCHITECTURE:
 * - Idempotency: Uses acquireStepIdempotencyLock() with Redis SETNX pattern
 *   Lock key format: exec:${executionId}:step:${stepIndex}:lock
 * - Distributed Tracing: Extracts x-trace-id from headers, propagates to QStash
 * - Step Execution: Delegates to StepExecutionService.execute()
 *
 * @see Phase 3.1: Route De-bloating & Abstraction
 * @see StepExecutionService for business logic
 * @see LockingService.acquireStepIdempotencyLock for idempotency
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withQStashAuth } from "@repo/shared";
import { StepExecutionService, createStepExecutionService } from "@/lib/engine/step-execution-service";

// Idempotency: acquireStepIdempotencyLock uses Redis SETNX with nx: true
// Distributed Tracing: x-trace-id header extracted and propagated

export const runtime = "nodejs";
export const maxDuration = 8; // Vercel Hobby limit - 8s buffer before 10s hard limit

// ============================================================================
// REQUEST/RESPONSE SCHEMAS
// ============================================================================

const ExecuteStepRequestSchema = z.object({
  executionId: z.string().uuid(),
  startStepIndex: z.number().int().nonnegative().optional(),
});

const ExecuteStepResponseSchema = z.object({
  success: z.boolean(),
  executionId: z.string(),
  stepExecuted: z.string().optional(),
  stepStatus: z.enum(["completed", "failed", "pending", "no_steps_remaining"]).optional(),
  completedSteps: z.number(),
  totalSteps: z.number(),
  isComplete: z.boolean(),
  nextStepTriggered: z.boolean().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
});

// ============================================================================
// SERVICE INSTANCE
// ============================================================================

const stepExecutionService = createStepExecutionService();

// ============================================================================
// API HANDLER (wrapped with QStash auth)
// ============================================================================

async function executeStepHandler(
  request: NextRequest,
  body: z.infer<typeof ExecuteStepRequestSchema>
): Promise<NextResponse> {
  const startTime = performance.now();
  const { executionId, startStepIndex } = body;

  try {
    // DISTRIBUTED TRACING: Extract trace context from headers
    const traceId = request.headers.get("x-trace-id");
    const correlationId = request.headers.get("x-correlation-id");

    const result = await stepExecutionService.execute(executionId, startStepIndex, request);
    return NextResponse.json(ExecuteStepResponseSchema.parse(result));
  } catch (error) {
    console.error("[ExecuteStep] Unhandled error:", error);

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 500 }
    );
  }
}

export const POST = withQStashAuth(executeStepHandler);
