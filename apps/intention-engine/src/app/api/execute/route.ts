import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { withUnifiedApiHandler } from "@repo/shared/errors";
import { Logger } from "@repo/shared";
import {
  orchestrateExecution,
  getExecutionStatus,
} from "@/lib/engine/orchestrator";

const logger = new Logger({ serviceName: "execute-api" });

export const runtime = "nodejs";

const ExecuteRequestSchema = z.object({
  input: z.string().min(1).max(10000),
  context: z
    .object({
      execution_id: z.string().optional(),
      user_context: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  options: z
    .object({
      skip_planning: z.boolean().optional(),
      require_confirmation: z.boolean().optional(),
    })
    .optional(),
});

const ExecuteResponseSchema = z.object({
  success: z.boolean(),
  execution_id: z.string(),
  status: z.string(),
  intent: z.unknown().optional(),
  plan: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
  trace: z.unknown(),
  metadata: z.object({
    duration_ms: z.number(),
    total_tokens: z.number(),
    step_count: z.number().optional(),
    trace_id: z.string(),
    total_ms: z.number(),
  }),
});

async function postHandler(request: NextRequest): Promise<NextResponse> {
  const requestStartTime = performance.now();

  // Parse and validate request body with error handling
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid or malformed JSON request body",
        },
      },
      { status: 400 },
    );
  }
  const validation = ExecuteRequestSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: `Invalid request: ${validation.error.message}`,
        },
      },
      { status: 400 },
    );
  }

  const { input, context, options } = validation.data;

  // Execute orchestration via extracted service
  const result = await orchestrateExecution(input, context, options);

  // Build response
  const response = ExecuteResponseSchema.parse({
    success: result.success,
    execution_id: result.execution_id,
    status: result.status,
    intent: result.intent,
    plan: result.plan,
    result: result.execution_result,
    error: result.error,
    trace: result.trace,
    metadata: result.metadata,
  });

  const requestDuration = Math.round(performance.now() - requestStartTime);
  logger.info("Execute request completed", {
    executionId: result.execution_id,
    durationMs: requestDuration,
    status: result.status,
  });

  let status = result.success ? 200 : 400;
  if (result.status === "REJECTED") {
    status = 403;
  }

  return NextResponse.json(response, {
    status,
  });
}

async function getHandler(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const executionId = searchParams.get("execution_id");

  if (!executionId) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "MISSING_PARAMETER",
          message: "execution_id query parameter is required",
        },
      },
      { status: 400 },
    );
  }

  const result = await getExecutionStatus(executionId);

  if (!result.success) {
    return NextResponse.json(
      {
        success: false,
        error: result.error,
      },
      { status: 404 },
    );
  }

  return NextResponse.json({
    success: true,
    execution_id: executionId,
    status: result.state?.status,
    state: result.state,
  });
}

// Wrap handlers with error handler for centralized error formatting and metrics
export const POST = withUnifiedApiHandler(postHandler, {
  serviceName: "execute",
});
export const GET = withUnifiedApiHandler(getHandler, {
  serviceName: "execute",
});
