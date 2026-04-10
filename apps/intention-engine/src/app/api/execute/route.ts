import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { withNervousSystemTracing } from "@repo/shared/tracing";
import {
  withUnifiedApiHandler,
  ServiceUnavailableError,
} from "@repo/shared/errors";
import { startTrace } from "@/lib/observability";
import { saveUserInteractionContext } from "@/lib/context-persistence";
import { QStashService, Logger } from "@repo/shared";
import { AppConfig } from "@repo/shared";

const logger = new Logger({ serviceName: "execute-api" });

// Engine imports
import {
  ExecutionState,
  ExecutionStatus,
  Intent,
  Plan,
  ExecutionTrace,
  ExecutionResult,
} from "@/lib/engine/types";
import {
  parseIntent,
  ParseResult,
  validateIntentConfidence,
} from "@/lib/engine/intent";
import { generatePlan, PlannerResult } from "@/lib/engine/planner";
import { generateText } from "@/lib/engine/llm";
import {
  WorkflowToolExecutor as ToolExecutor,
  executeWorkflow,
  WorkflowMachine,
} from "@/lib/engine/workflow-machine"; // Use WorkflowMachine directly
import {
  createInitialState,
  transitionState,
  setIntent,
  setPlan,
} from "@/lib/engine/state-machine";
import {
  saveExecutionState,
  loadExecutionState,
  getMemoryClient,
} from "@/lib/engine/memory";
import { createTracer } from "@/lib/engine/tracing";
import {
  getToolRegistry,
  ToolExecutionContext,
} from "@/lib/engine/tools/registry";
import { getRegistryManager } from "@/lib/engine/registry";
import { getRedisClient, ServiceNamespace } from "@repo/shared";
import { getDb } from "@repo/database";

// Lazy-initialized shared service instances for dependency injection
let _sharedRedis: any = null;
function getSharedRedis() {
  if (!_sharedRedis) _sharedRedis = getRedisClient(ServiceNamespace.SHARED);
  return _sharedRedis;
}
let _sharedDb: any = null;
function getSharedDb() {
  if (!_sharedDb) _sharedDb = getDb();
  return _sharedDb;
}
import { verifyPlan, DEFAULT_SAFETY_POLICY } from "@/lib/engine/verifier";

// Internal system key for QStash-triggered requests - uses strict getter
const INTERNAL_SYSTEM_KEY = AppConfig.getInternalSystemKey();

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

function createToolExecutorForExecution(executionId: string): ToolExecutor {
  const registry = getToolRegistry();

  return {
    execute: async (
      toolName: string,
      parameters: Record<string, unknown>,
      timeoutMs: number,
    ) => {
      const context: ToolExecutionContext = {
        executionId,
        stepId: "unknown",
        timeoutMs,
        startTime: performance.now(),
        services: {
          redis: getSharedRedis(),
          db: getSharedDb(),
        },
      };
      const result = await registry.execute(
        toolName,
        parameters,
        context,
        undefined, // Use latest version
      );

      return {
        success: result.success,
        output: result.output,
        error: result.error,
        latency_ms: result.latency_ms,
      };
    },
  };
}

interface OrchestrationResult {
  success: boolean;
  execution_id: string;
  status: ExecutionStatus;
  intent?: Intent;
  plan?: Plan;
  execution_result?: ExecutionResult;
  error?: {
    code: string;
    message: string;
  };
  trace: ExecutionTrace;
  metadata: {
    duration_ms: number;
    total_tokens: number;
    step_count?: number;
    trace_id: string;
    total_ms: number;
  };
}

async function orchestrateExecution(
  input: string,
  context: {
    execution_id?: string;
    user_context?: Record<string, unknown>;
  } = {},
  options: { skip_planning?: boolean; require_confirmation?: boolean } = {},
): Promise<OrchestrationResult> {
  const startTime = performance.now();
  const executionId = context.execution_id || randomUUID();

  return await withNervousSystemTracing(
    async ({ correlationId }) => {
      const span = startTrace("orchestration", correlationId);

      // Initialize Registry and Discovery
      const registryManager = getRegistryManager();
      await registryManager.discoverRemoteTools();

      // Initialize tracer
      const tracer = createTracer(executionId);
      tracer.addSystemEntry("execution_started", {
        input: input.slice(0, 100),
      });

      try {
        // Step 1: Create initial state
        let state = createInitialState(executionId);
        tracer.addStateTransitionEntry("none", "RECEIVED", true);

        // Persist initial state
        await saveExecutionState(state);

        // Step 2: Parse intent
        tracer.addSystemEntry("parsing_intent");
        const parseResult: ParseResult = await parseIntent(input, {
          execution_id: executionId,
          user_context: context.user_context,
        });

        // Add intent trace entry
        tracer.addIntentEntry(
          input,
          parseResult.intent,
          parseResult.latency_ms,
          parseResult.intent.metadata.model_id || "unknown",
          {
            prompt: parseResult.token_usage.prompt_tokens,
            completion: parseResult.token_usage.completion_tokens,
          },
        );

        // Update state with intent
        state = setIntent(state, parseResult.intent);
        await saveExecutionState(state);

        // Validate intent confidence and type
        const validation = validateIntentConfidence(parseResult.intent);

        if (!validation.valid) {
          tracer.addSystemEntry("intent_rejected", {
            reason: validation.reason,
          });

          const traceResult = tracer.finalize();
          span.end();

          return {
            success: false,
            execution_id: executionId,
            status: "REJECTED",
            intent: parseResult.intent,
            error: {
              code: "INTENT_VALIDATION_FAILED",
              message: validation.reason || "Intent validation failed",
            },
            trace: traceResult.trace,
            metadata: {
              duration_ms: Math.round(performance.now() - startTime),
              total_tokens: traceResult.totalTokenUsage.totalTokens,
              trace_id: executionId,
              total_ms: Math.round(performance.now() - startTime),
            },
          };
        }

        // Save interaction context for conversational continuity (Objective 5)
        // Extract user ID from context if available
        const userId = context.user_context?.userId as string | undefined;
        if (userId) {
          await saveUserInteractionContext(userId, {
            intentType: parseResult.intent.type,
            rawText: parseResult.intent.rawText,
            parameters: parseResult.intent.parameters as Record<
              string,
              unknown
            >,
            timestamp: new Date().toISOString(),
            executionId,
          });
        }

        // Check if intent requires clarification
        if (parseResult.intent.requires_clarification) {
          tracer.addSystemEntry("clarification_required", {
            prompt: parseResult.intent.clarification_prompt,
          });

          const traceResult = tracer.finalize();
          span.end();

          return {
            success: false,
            execution_id: executionId,
            status: "REJECTED",
            intent: parseResult.intent,
            error: {
              code: "CLARIFICATION_REQUIRED",
              message:
                parseResult.intent.clarification_prompt ||
                "Additional information needed",
            },
            trace: traceResult.trace,
            metadata: {
              duration_ms: Math.round(performance.now() - startTime),
              total_tokens: traceResult.totalTokenUsage.totalTokens,
              trace_id: executionId,
              total_ms: Math.round(performance.now() - startTime),
            },
          };
        }

        // Step 3: Generate plan (unless skipped)
        let plan: Plan | undefined;
        if (!options.skip_planning) {
          tracer.addSystemEntry("generating_plan");
          const planResult: PlannerResult = await generatePlan(
            parseResult.intent,
            {
              execution_id: executionId,
              available_tools: registryManager.listAllTools(),
            },
          );

          // Add planning trace entry
          tracer.addPlanningEntry(
            { intent_type: parseResult.intent.type },
            {
              plan_id: planResult.plan.id,
              steps: planResult.plan.steps.length,
            },
            planResult.latency_ms,
            planResult.trace_entry.model_id || "unknown",
            {
              prompt: planResult.token_usage.prompt_tokens,
              completion: planResult.token_usage.completion_tokens,
            },
          );

          plan = planResult.plan;

          // Step 3.5: Deterministic Verification Gate
          const verification = verifyPlan(plan, DEFAULT_SAFETY_POLICY);
          if (!verification.valid) {
            tracer.addSystemEntry("plan_rejected", {
              reason: verification.reason,
              violation: verification.violation,
            });

            // Transition state to REJECTED
            state = transitionState(state, "REJECTED");
            await saveExecutionState(state);

            const traceResult = tracer.finalize();
            span.end();

            return {
              success: false,
              execution_id: executionId,
              status: "REJECTED",
              intent: parseResult.intent,
              plan,
              error: {
                code: verification.violation || "PLAN_VALIDATION_FAILED",
                message: verification.reason || "Plan verification failed",
              },
              trace: traceResult.trace,
              metadata: {
                duration_ms: Math.round(performance.now() - startTime),
                total_tokens: traceResult.totalTokenUsage.totalTokens,
                trace_id: executionId,
                total_ms: Math.round(performance.now() - startTime),
              },
            };
          }

          state = setPlan(state, plan);
          await saveExecutionState(state);
        }

        // Step 4: TRIGGER ASYNC EXECUTION VIA QSTASH (Vercel Hobby Pattern)
        // Instead of executing synchronously, we trigger Step 0 via QStash and return immediately
        if (plan) {
          tracer.addSystemEntry("triggering_async_execution", {
            step_count: plan.steps.length,
          });

          // Trigger the FIRST step via QStash
          // This starts the recursive self-trigger chain
          // CRITICAL: Pass trace context for distributed tracing
          await QStashService.triggerNextStep({
            executionId,
            stepIndex: 0,
            internalKey: INTERNAL_SYSTEM_KEY,
            traceId: executionId, // Use executionId as initial traceId
            correlationId: executionId,
          });

          // Finalize trace
          const traceResult = tracer.finalize();
          span.end();

          // Return immediately - execution will happen asynchronously
          return {
            success: true,
            execution_id: executionId,
            status: "STARTED",
            intent: parseResult.intent,
            plan,
            trace: traceResult.trace,
            metadata: {
              duration_ms: Math.round(performance.now() - startTime),
              total_tokens: traceResult.totalTokenUsage.totalTokens,
              step_count: plan.steps.length,
              trace_id: executionId,
              total_ms: Math.round(performance.now() - startTime),
            },
          };
        } else {
          // No plan to execute (planning skipped or no plan generated)
          const traceResult = tracer.finalize();
          span.end();

          return {
            success: true,
            execution_id: executionId,
            status: "PLANNED",
            intent: parseResult.intent,
            plan,
            trace: traceResult.trace,
            metadata: {
              duration_ms: Math.round(performance.now() - startTime),
              total_tokens: traceResult.totalTokenUsage.totalTokens,
              trace_id: executionId,
              total_ms: Math.round(performance.now() - startTime),
            },
          };
        }
      } catch (error) {
        // Handle orchestration errors
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const errorCode =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "ORCHESTRATION_ERROR";

        tracer.addErrorEntry("system", errorCode, errorMessage);
        const traceResult = tracer.finalize();
        span.end();

        return {
          success: false,
          execution_id: executionId,
          status: "FAILED",
          error: {
            code: errorCode,
            message: errorMessage,
          },
          trace: traceResult.trace,
          metadata: {
            duration_ms: Math.round(performance.now() - startTime),
            total_tokens: traceResult.totalTokenUsage.totalTokens,
            trace_id: executionId,
            total_ms: Math.round(performance.now() - startTime),
          },
        };
      }
    },
    { "x-trace-id": executionId },
  );
}

async function getExecutionStatus(executionId: string): Promise<{
  success: boolean;
  state?: ExecutionState;
  trace?: ExecutionTrace;
  error?: { code: string; message: string };
}> {
  try {
    const state = await loadExecutionState(executionId);

    if (!state) {
      return {
        success: false,
        error: {
          code: "EXECUTION_NOT_FOUND",
          message: `Execution ${executionId} not found`,
        },
      };
    }

    return {
      success: true,
      state,
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: "LOAD_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

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

  // Execute orchestration
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
  logger.info({
    message: "Execute request completed",
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
